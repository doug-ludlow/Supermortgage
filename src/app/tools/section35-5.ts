/**
 * §35.5 process-owned tools — the `cashiering` agent's schedule, cycle, lockbox, ACH and configuration tools
 * (spec/sections/35-operations-runtime/35-5-the-installment-schedule-and-the-daily-cashiering-cycle.md "AI agent design"),
 * defined with `defineTools("35.5", "cashiering", defs)` and spread by ./index.ts. Every tool runs on the command's own
 * transaction (`ctx.q`): what it writes commits with its decision record and events, or not at all.
 *
 *   installments.write      act   {loan_id, source?} — the schedule for a boarded loan that has none (a backfill / correction; the
 *                                 boarding paths write it inside their own transaction through src/domain/operations-runtime/boarding-writes.ts).
 *   installments.reproject  act   {loan_id, trigger_event_id} — rule 3 from the terms event (`loan_terms.activated`, `loan_terms.version.activated`,
 *                                 `loan_terms.versioned`): the new `loan_terms` version row, the replaced `due` rows, `installment.schedule.reprojected`;
 *                                 {loan_id, effective_from, note_rate_bps, pi_cents, …} by an `officer` after a 4.1 correction (never by an agent's own figure).
 *   installments.read       read  {loan_id, from?, through?} — the rows and the schedule runs.
 *   cashiering.run_unit     act   {loan_id, as_of} — rule 6: the loan's daily unit (cashiering-cycle.ts).
 *   lockbox.ingest          act   rule 7 (lockbox.ts).        lockbox.item.resolve  act  an ops_analyst names the loan; an amount change needs officer.
 *   ach.file.build          act   rule 8 (ach.ts).            ach.returns.ingest    act  the return file.      ach.return.action  act  one entry.
 *   servicing_config.write  act   rule 9: a configuration row — the state default for a loan without one (agent), a manual zone (`compliance`).
 *   servicer_profile.write  act   {op: activate, effective_from, fields} — `compliance` only; `servicer_profile.activated{version}` with the decision id.
 *   writeDecision           act   the decision row.
 *
 * Guardrails (the AI agent design paragraph): SCHEDULE_REQUIRED, SATISFIED_ROW_FROZEN, NO_CLIENT_STATE, ONE_UNIT_PER_LOAN_PER_DAY,
 * CONTROL_TOTAL_MATCH, GATES_ARE_2_3S, MAX_2_REINITIATIONS_180, NSF_ONLY_WHERE_ALLOWED, CONFIG_REQUIRED, NO_MONEY_FIELD (no tool here changes
 * a money field outside the owning engine's command with the owning role: an input naming a `*_cents` override, `changes`, a `waive` or an
 * `override` from an agent actor is refused with nothing written).
 */
import { randomUUID } from "node:crypto";
import { defineTools, compute, decision, never, guard, str, type ToolDef, type ToolInput } from "../tools.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import { hasRole } from "../roles.ts";
import type { Queryable } from "../../infra/db/client.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { planScheduleAtBoarding, persistSchedule, appendScheduleWritten, reprojectSchedule, readInstallments, scheduleRuns, ScheduleRefused, SCHEDULE_RULE_SET, REPROJECT_TRIGGERS } from "../../domain/operations-runtime/installments.ts";
import { activeServicerProfile, activateServicerProfile, jurisdictionCashRules, planServicingConfig, persistServicingConfig, appendConfigWritten, loanServicingConfigOrNull, servicerProfileVersions, ConfigRequired, stateTimeZone } from "../../domain/operations-runtime/servicing-config.ts";
import { lateChargePctFromBps } from "../../domain/operations-runtime/boarding-writes.ts";
import { runCashieringUnit } from "../../domain/operations-runtime/cashiering-cycle.ts";

export const CASHIERING_PROCESS = "35.5";
export const CASHIERING_AGENT_NAME = "cashiering";
export const CASHIERING_PROMPT_VERSION = "35.5-v1";
export const RULE_SETS = { schedule: "cashiering.schedule.v1", allocation: "cashiering.allocation.v1", returns: "cashiering.returns.v1" } as const;

const has = (i: ToolInput, k: string): boolean => i[k] !== undefined && i[k] !== null && i[k] !== "";
const moneyKey = (k: string): boolean => /_cents$/.test(k);
const namesMoney = (v: unknown): boolean => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v as Record<string, unknown>).some(moneyKey);
/** The command's transaction: every 35.5 tool reads and writes inside it (a unit harness without a database refuses with a typed reason). */
export const txOf = (ctx: CommandContext): Queryable => { if (!ctx.q) throw new RangeError("35.5 tools run inside a database command (PgUnitOfWork): no transaction on this context"); return ctx.q; };
const refused = (name: string, code: string, citation: string, reason: string): never => { throw new CommandRefused(name, code, citation, reason); };
/** Rule 10 / NO_MONEY_FIELD: an agent never names a money figure, a waiver or an override on these tools; an officer's figure rides on `installments.reproject` alone (a 4.1 correction). */
export const NO_MONEY_FIELD = guard("NO_MONEY_FIELD", "35.5 guardrails: `NO_MONEY_FIELD` (no tool here changes a money field outside the owning engine's command with the owning role); rule 10 'a fee waiver, a lockbox variance resolution that changes an amount, or a reprojection touching a satisfied row is an `officer` command with a decision record, refused otherwise with nothing written'",
  (i, ctx) => {
    if (has(i, "waive") || has(i, "fee_waiver") || has(i, "waiver")) return "a fee waiver is 2.7's `fees.waive` by an officer, never a 35.5 tool's input";
    if (namesMoney(i["changes"]) || namesMoney(i["overrides"]) || has(i, "changes") || has(i, "overrides")) return "a money correction is the owning engine's officer command; 35.5 tools take no `changes` / `overrides`";
    if (ctx.actor.kind !== "human" && Object.keys(i).some(moneyKey) && !has(i, "trigger_event_id")) return "an agent never supplies a money figure here (`*_cents`); a reprojection takes its figures from the terms event (`trigger_event_id`), a correction from an officer";
    if (has(i, "override") && !hasRole(ctx.actor, ["officer"])) return "an override of an automatic action is an officer's act";
    return undefined;
  });
/** The decision record schema of the AI agent design paragraph. */
export function cashieringDecision(d: { subject: { kind: string; id: string }; action: string; loan_id?: string | null; inputs?: Record<string, unknown>; outputs?: Record<string, unknown>; rule_set: string; rationale: string }): { action: string; rationale: string; subject: { kind: string; id: string }; ruleCode: string; modelVersion: string; promptVersion: string; confidence: number } {
  const record = { ...(d.loan_id ? { loan_id: d.loan_id } : {}), action: d.action, inputs: d.inputs ?? {}, outputs: d.outputs ?? {}, rule_set_version: d.rule_set, model_version: "deterministic", prompt_version: CASHIERING_PROMPT_VERSION, confidence: 1, rationale: d.rationale };
  return { action: d.action, rationale: JSON.stringify(record, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), subject: d.subject, ruleCode: "35.5", modelVersion: "deterministic", promptVersion: CASHIERING_PROMPT_VERSION, confidence: 1 };
}
const out = (o: unknown): Record<string, unknown> => (o ?? {}) as Record<string, unknown>;
const loanIdOf = (i: ToolInput, ctx: CommandContext): string => { const id = str(i, "loan_id") || ctx.loanId; if (!id) throw new RangeError("loan_id is required"); return id; };
type Raw = Record<string, unknown>;
const c = (v: unknown): Cents => (v === null || v === undefined || v === "" ? 0n : BigInt(String(v)));

/** The loan's row, its terms in force and its property state — what the schedule and configuration tools read (rules 1 and 9). */
async function loanTermsFacts(q: Queryable, loanId: string): Promise<{ loan: Raw; terms: Raw; state: string | null }> {
  const loan = (await q.query<Raw>(`SELECT l.id::text AS id, l.first_payment_date::text AS first_payment_date, l.maturity_date::text AS maturity_date, l.original_upb_cents::text AS original_upb_cents, l.original_term_months, l.origination_application_id::text AS origination_application_id, l.boarded_at::text AS boarded_at, pr.state FROM loans l LEFT JOIN properties pr ON pr.id = l.property_id WHERE l.id = $1`, [loanId]))[0];
  if (!loan) throw new RangeError(`no loan ${loanId}`);
  const terms = (await q.query<Raw>(`SELECT id::text AS id, effective_from::text AS effective_from, note_rate_bps, pi_cents::text AS pi_cents, escrow_payment_cents::text AS escrow_payment_cents, escrowed, remittance_type::text AS remittance_type, late_charge_pct_bps, late_charge_grace_days, maturity_date::text AS maturity_date, remaining_term_months, amortization::text AS amortization, interest_method::text AS interest_method FROM loan_terms WHERE loan_id = $1 ORDER BY effective_from DESC, created_at DESC LIMIT 1`, [loanId]))[0];
  if (!terms) throw new RangeError(`no loan_terms for ${loanId}`);
  return { loan, terms, state: (loan.state as string | null) ?? null };
}

/** `installments.write` — rule 1 for a boarded loan with no rows yet (the boarding paths write the schedule in their own transaction). */
async function installmentsWrite(i: ToolInput, ctx: CommandContext): Promise<unknown> {
  const q = txOf(ctx); const loanId = loanIdOf(i, ctx);
  const existing = await readInstallments(q, loanId);
  if (existing.length) return { loan_id: loanId, rows: existing.length, written: false, run_id: (await scheduleRuns(q, loanId)).at(-1)?.id ?? null, reason: "the loan already has its schedule (a terms change is `installments.reproject`)" };
  const { loan, terms, state } = await loanTermsFacts(q, loanId);
  const source = (str(i, "source") || (loan.origination_application_id ? "fund" : "transfer")) as "fund" | "transfer";
  if (has(i, "upb_cents") && !hasRole(ctx.actor, ["officer"])) refused("installments.write", "NO_MONEY_FIELD", "35.5 rule 10: 'Nothing here decides a money figure' — a boarding UPB other than the ledger's is an officer's correction with a decision record", "`upb_cents` on installments.write is an officer's figure; the schedule projects from the ledger's principal balance otherwise");
  const decisionId = randomUUID();
  const upb = has(i, "upb_cents") ? c(i["upb_cents"]) : c((await q.query<{ s: string | null }>(`SELECT sum(amount_cents)::text AS s FROM ledger_lines WHERE scope = 'loan' AND loan_id = $1 AND account = 'principal'`, [loanId]))[0]?.s ?? loan.original_upb_cents);
  const nextDue = str(i, "next_due_date") ? D(str(i, "next_due_date")) : null;
  try {
    const plan = planScheduleAtBoarding({ loan_id: loanId, terms_id: String(terms.id), source, note_rate_bps: Number(terms.note_rate_bps), pi_cents: c(terms.pi_cents), escrow_cents: c(terms.escrow_payment_cents), first_payment_date: D(String(loan.first_payment_date)), maturity_date: D(String(terms.maturity_date ?? loan.maturity_date)), upb_cents: upb > 0n ? upb : c(loan.original_upb_cents),
      next_due_date: nextDue, original_upb_cents: c(loan.original_upb_cents), original_term_months: Number(loan.original_term_months ?? 360) });
    await persistSchedule(q, plan, { decision_id: decisionId });
    const ev = appendScheduleWritten(ctx.events, plan, ctx.actor);
    void state;
    const d = cashieringDecision({ subject: { kind: "installment_schedule_run", id: plan.run_id }, action: "installments.write", loan_id: loanId, inputs: { source, upb_cents: upb.toString(), next_due_date: nextDue }, outputs: { rows: plan.projection.rows.length, sha256: plan.projection.sha256, maturity_variance_cents: plan.projection.maturity_variance_cents.toString() }, rule_set: RULE_SETS.schedule, rationale: `schedule written from the boarded terms (${source}); ${plan.projection.rows.length} rows, sha256 ${plan.projection.sha256.slice(0, 12)}…` });
    ctx.decide({ id: decisionId, agent: CASHIERING_AGENT_NAME, action: d.action, rationale: d.rationale, ruleSetVersion: RULE_SETS.schedule, loanId, subject: d.subject, ruleCode: d.ruleCode, modelVersion: d.modelVersion, promptVersion: d.promptVersion, confidence: d.confidence });
    return { loan_id: loanId, run_id: plan.run_id, decision_id: decisionId, rows: plan.projection.rows.length, written: true, source, pi_cents: plan.pi_cents.toString(), first_due: plan.projection.rows[0]!.due_date, last_due: plan.projection.rows[plan.projection.rows.length - 1]!.due_date, total_interest_cents: plan.projection.total_interest_cents.toString(), total_principal_cents: plan.projection.total_principal_cents.toString(), maturity_variance_cents: plan.projection.maturity_variance_cents.toString(), hf005_difference_cents: plan.hf005.difference_cents.toString(), sha256: plan.projection.sha256, event_id: ev.id };
  } catch (e) { if (e instanceof ScheduleRefused) refused("installments.write", e.code, "35.5 rule 1: `SCHEDULE_REQUIRED` — a boarding that cannot write the schedule refuses the board; rule 2 (HF-005's tolerance)", e.message); throw e; }
}

/** The reprojection inputs a terms event carries (rule 3 / Inputs and triggers: the three spellings) — the cut is the first installment the new terms govern. */
export function reprojectionFromEvent(ev: { type: string; payload: Record<string, unknown> }, terms: Raw): { effective_from: PlainDate; note_rate_bps: number; pi_cents: Cents; escrow_cents: Cents | null; source: string; version: number | null } | null {
  const p = ev.payload; const curRate = Number(terms.note_rate_bps); const curPi = c(terms.pi_cents);
  const rateBps = typeof p.rate_pct === "string" || typeof p.rate_pct === "number" ? Math.round(Number(p.rate_pct) * 10_000) : curRate;
  const version = p.version !== undefined ? Number(p.version) : p.loan_terms_version !== undefined ? Number(p.loan_terms_version) : null;
  if (ev.type === "loan_terms.version.activated") {
    const cut = typeof p.payment_effective_due === "string" ? p.payment_effective_due : typeof p.effective_on === "string" ? p.effective_on : null; if (!cut) return null;
    return { effective_from: D(cut), note_rate_bps: rateBps, pi_cents: p.pi_cents !== undefined ? c(p.pi_cents) : curPi, escrow_cents: null, source: "arm_change", version };
  }
  if (ev.type === "loan_terms.activated") {
    const cut = typeof p.effective_on === "string" ? p.effective_on : typeof p.effective_from === "string" ? p.effective_from : null; if (!cut) return null;
    return { effective_from: D(cut), note_rate_bps: rateBps, pi_cents: p.new_pi_cents !== undefined ? c(p.new_pi_cents) : p.pi_cents !== undefined ? c(p.pi_cents) : curPi, escrow_cents: null, source: p.reason === "reamortization" ? "modification" : "correction", version };
  }
  if (ev.type === "loan_terms.versioned") {
    const cut = typeof p.effective_from === "string" ? p.effective_from : typeof p.effective_date === "string" ? p.effective_date : typeof p.next_due === "string" ? p.next_due : null; if (!cut) return null;
    return { effective_from: D(cut), note_rate_bps: rateBps, pi_cents: p.pi_cents !== undefined ? c(p.pi_cents) : curPi, escrow_cents: p.escrow_payment_cents !== undefined ? c(p.escrow_payment_cents) : null, source: p.reason === "escrow_repayment_plan" || p.escrow_payment_cents !== undefined ? "escrow_analysis" : "modification", version };
  }
  return null;
}

/** `installments.reproject` — rule 3: from the terms event, or an officer's figures after a 4.1 correction. Idempotent per trigger event. */
export async function installmentsReproject(i: ToolInput, ctx: CommandContext): Promise<unknown> {
  const q = txOf(ctx); const loanId = loanIdOf(i, ctx);
  const { loan, terms } = await loanTermsFacts(q, loanId);
  const triggerId = str(i, "trigger_event_id") || null;
  let inputs: { effective_from: PlainDate; note_rate_bps: number; pi_cents: Cents; escrow_cents: Cents | null; source: string; version: number | null };
  // rule 3: an ARM change projects from the expected UPB 7.2 computed (= the row's `upb_before_cents`, worked example C); 2.4's re-amortization (Form 181) projects from the loan's actual UPB — the ledger's principal balance this command sees (a curtailment between rows is why it re-amortized)
  let reamortizedUpb: Cents | null = null;
  if (triggerId) {
    const done = (await scheduleRuns(q, loanId)).find((r) => r.trigger_event_id === triggerId);
    if (done) return { loan_id: loanId, run_id: done.id, rows_kept: done.rows_kept, rows_replaced: done.rows_replaced, reprojected: false, reason: "this terms event was already re-projected" };
    const ev = ctx.events.all().find((e) => e.id === triggerId && e.loanId === loanId);
    if (!ev) throw new RangeError(`trigger_event_id ${triggerId} is not an event on loan ${loanId}`);
    if (!REPROJECT_TRIGGERS.includes(ev.type)) throw new RangeError(`${ev.type} is not a terms activation (${REPROJECT_TRIGGERS.join(", ")})`);
    const from = reprojectionFromEvent(ev, terms); if (!from) throw new RangeError(`${ev.type} ${ev.id} names no effective date`);
    inputs = from;
    if (ev.type === "loan_terms.activated" && String((ev.payload as Raw).reason ?? "") === "reamortization") { const bal = ctx.ledger.balance({ scope: "loan", loanId, account: "principal" }); if (bal > 0n) reamortizedUpb = bal; }
  } else {
    if (!hasRole(ctx.actor, ["officer"])) refused("installments.reproject", "NO_MONEY_FIELD", "35.5 rule 10 / Inputs and triggers: '`installments.reproject` by hand after a 4.1 correction (`officer`)'", "a reprojection without a terms event is an officer's correction; an agent names the `trigger_event_id`");
    if (!str(i, "effective_from")) throw new RangeError("installments.reproject needs trigger_event_id, or effective_from (+ note_rate_bps / pi_cents / escrow_cents) from an officer");
    inputs = { effective_from: D(str(i, "effective_from")), note_rate_bps: has(i, "note_rate_bps") ? Number(i["note_rate_bps"]) : Number(terms.note_rate_bps), pi_cents: has(i, "pi_cents") ? c(i["pi_cents"]) : c(terms.pi_cents), escrow_cents: has(i, "escrow_cents") ? c(i["escrow_cents"]) : null, source: "correction", version: null };
  }
  // the new `loan_terms` version row the replaced rows are projected under (the FK the rows carry): the terms in force after `effective_from`
  const termsId = randomUUID(); const decisionId = randomUUID();
  const remaining = (await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_installments WHERE loan_id = $1 AND due_date >= $2::date`, [loanId, inputs.effective_from]))[0]?.n ?? "0";
  try {
    await q.query(`INSERT INTO loan_terms (id, loan_id, effective_from, source, source_event_id, amortization, note_rate_bps, pi_cents, escrow_payment_cents, escrowed, interest_method, remittance_type, late_charge_pct_bps, late_charge_grace_days, maturity_date, remaining_term_months)
      VALUES ($1, $2, $3, $4, $5, $6::amortization_type, $7, $8, $9, $10, $11::interest_method, $12::remittance_type, $13, $14, $15, $16)`,
      [termsId, loanId, inputs.effective_from, inputs.source, triggerId, String(terms.amortization ?? "fixed"), inputs.note_rate_bps, inputs.pi_cents.toString(), (inputs.escrow_cents ?? c(terms.escrow_payment_cents)).toString(), terms.escrowed === true, String(terms.interest_method ?? "30_360"), String(terms.remittance_type ?? "A/A"), terms.late_charge_pct_bps ?? null, terms.late_charge_grace_days ?? null, String(terms.maturity_date ?? loan.maturity_date), Number(remaining)]);
    const r = await reprojectSchedule(q, ctx.events, ctx.actor, { loan_id: loanId, terms_id: termsId, effective_from: inputs.effective_from, note_rate_bps: inputs.note_rate_bps, pi_cents: inputs.pi_cents, escrow_cents: inputs.escrow_cents, decision_id: decisionId, upb_start_cents: has(i, "upb_start_cents") && hasRole(ctx.actor, ["officer"]) ? c(i["upb_start_cents"]) : reamortizedUpb, source: inputs.source === "correction" ? "correction" : "reprojection", trigger_event_id: triggerId, maturity_date: D(String(terms.maturity_date ?? loan.maturity_date)) });
    const d = cashieringDecision({ subject: { kind: "installment_schedule_run", id: r.run_id }, action: "installments.reproject", loan_id: loanId, inputs: { terms_id: termsId, trigger_event_id: triggerId, effective_from: inputs.effective_from, source: inputs.source }, outputs: { rows_kept: r.rows_kept, rows_replaced: r.rows_replaced, sha256: r.sha256, rate_bps: inputs.note_rate_bps, pi_cents: inputs.pi_cents.toString() }, rule_set: RULE_SETS.schedule, rationale: `rows from ${inputs.effective_from} re-projected under ${inputs.source} terms (${triggerId ? `event ${triggerId}` : "officer correction"}); ${r.rows_kept} kept, ${r.rows_replaced} replaced` });
    ctx.decide({ id: decisionId, agent: CASHIERING_AGENT_NAME, action: d.action, rationale: d.rationale, ruleSetVersion: RULE_SETS.schedule, loanId, subject: d.subject, ruleCode: d.ruleCode, modelVersion: d.modelVersion, promptVersion: d.promptVersion, confidence: d.confidence, ...(triggerId ? {} : { approvedBy: ctx.actor.id, ...(ctx.actor.role ? { approvedRole: ctx.actor.role } : {}) }) });
    return { loan_id: loanId, run_id: r.run_id, decision_id: decisionId, terms_id: termsId, terms_version: inputs.version, terms_source: inputs.source, effective_from: inputs.effective_from, rate_bps: inputs.note_rate_bps, pi_cents: inputs.pi_cents.toString(), rows_kept: r.rows_kept, rows_replaced: r.rows_replaced, sha256: r.sha256, reprojected: true, event_id: r.event.id, trigger_event_id: triggerId };
  } catch (e) {
    if (e instanceof ScheduleRefused) { refused("installments.reproject", e.code, e.code === "SATISFIED_ROW_FROZEN" ? "35.5 rule 3: 'a reprojection that would change a `satisfied` row is refused (`SATISFIED_ROW_FROZEN`) and escalated to `officer` — a satisfied row changes only through 2.1's reversal'" : "35.5 rule 3", e.message); }
    throw e;
  }
}

/** `servicing_config.write` — rule 9: the state default for a loan without a row (system / agent at boarding or backfill); a manual zone or jurisdiction is `compliance`'s. */
async function servicingConfigWrite(i: ToolInput, ctx: CommandContext): Promise<unknown> {
  const q = txOf(ctx); const loanId = loanIdOf(i, ctx);
  const manual = has(i, "time_zone") || has(i, "jurisdiction_state") || has(i, "servicer_profile_id");
  if (manual && !hasRole(ctx.actor, ["compliance"])) refused("servicing_config.write", "ROLE_DENIED", "35.5 Inputs and triggers: '`servicing_config.write{loan_id, time_zone?, jurisdiction_state?, servicer_profile_id?}` (`compliance`)'; rule 9 'every servicer-profile version and manual time-zone change (`compliance`)'", "a manual time zone, jurisdiction or profile is compliance's act");
  const today = D(ctx.now.slice(0, 10));
  const effectiveFrom = str(i, "effective_from") ? D(str(i, "effective_from")) : today;
  const { loan, terms, state } = await loanTermsFacts(q, loanId);
  const existing = await loanServicingConfigOrNull(q, loanId, effectiveFrom);
  if (existing && !manual) return { loan_id: loanId, config_id: existing.id, written: false, time_zone: existing.time_zone, jurisdiction_state: existing.jurisdiction_state, reason: "the loan already has a configuration in force" };
  const jurisdiction = (str(i, "jurisdiction_state") || state || "").toUpperCase();
  const profile = str(i, "servicer_profile_id") ? (await servicerProfileVersions(q)).find((v) => v.id === str(i, "servicer_profile_id")) ?? null : await activeServicerProfile(q, effectiveFrom);
  if (!profile) throw new RangeError(`servicer_profile_id ${str(i, "servicer_profile_id")} is not a version of the servicing party`);
  try {
    const plan = planServicingConfig({ loan_id: loanId, effective_from: effectiveFrom, state: jurisdiction, note: { pct: lateChargePctFromBps(terms.late_charge_pct_bps as number | null), grace_days: Number(terms.late_charge_grace_days ?? 15) }, rules: await jurisdictionCashRules(q, jurisdiction), servicer_profile_id: profile.id,
      ...(has(i, "time_zone") ? { time_zone: str(i, "time_zone"), time_zone_source: (str(i, "time_zone_source") || "manual") as "manual" } : {}), ...(str(i, "lockbox_id") ? { lockbox_id: str(i, "lockbox_id") } : {}), written_by: { actor: `${ctx.actor.kind}:${ctx.actor.id}`, role: ctx.actor.role ?? null, path: manual ? "manual" : "backfill", boarded_at: loan.boarded_at ?? null } });
    if (has(i, "time_zone")) { try { new Intl.DateTimeFormat("en-US", { timeZone: plan.time_zone }); } catch { throw new RangeError(`${plan.time_zone} is not an IANA time zone`); } }
    else stateTimeZone(jurisdiction);
    await persistServicingConfig(q, plan);
    const ev = appendConfigWritten(ctx.events, plan, ctx.actor);
    return { loan_id: loanId, config_id: plan.id, written: true, time_zone: plan.time_zone, time_zone_source: plan.time_zone_source, jurisdiction_state: plan.jurisdiction_state, servicer_profile_id: plan.servicer_profile_id, late_charge_terms: plan.late_charge_terms, nsf_fee_allowed: plan.nsf_fee_allowed, effective_from: plan.effective_from, event_id: ev.id };
  } catch (e) { if (e instanceof ConfigRequired) refused("servicing_config.write", e.code, "35.5 rule 9: `CONFIG_REQUIRED` (no loan-local date without a config row); 'the boarding never guesses'", e.message); throw e; }
}

const PROFILE_FIELDS = ["legal_name", "dba", "nmls_id", "toll_free_phone", "servicer_address", "exclusive_address", "remittance_address", "payment_requirements_version", "portal_url", "counselor_url", "hud_phone", "hours"] as const;
/** `servicer_profile.write{op: activate}` — rule 9: `compliance` activates a version effective today or later; the profile in force renders every notice from that date. */
async function servicerProfileWrite(i: ToolInput, ctx: CommandContext): Promise<unknown> {
  const q = txOf(ctx); const op = str(i, "op") || "activate";
  if (op === "read" || op === "list") return { versions: (await servicerProfileVersions(q, str(i, "party_id") || undefined)).map((v) => ({ ...v, tin_encrypted: undefined, tin_present: v.tin_encrypted !== null })) };
  if (op !== "activate") throw new RangeError("servicer_profile.write op is activate (or list)");
  const today = D(ctx.now.slice(0, 10)); const effectiveFrom = str(i, "effective_from") ? D(str(i, "effective_from")) : today;
  const fields: Record<string, unknown> = {}; for (const k of PROFILE_FIELDS) if (has(i, k)) fields[k] = String(i[k]);
  if (Array.isArray(i["languages"])) fields.languages = (i["languages"] as unknown[]).map(String);
  if (has(i, "tin")) fields.tin = String(i["tin"]);
  if (!Object.keys(fields).length) throw new RangeError("servicer_profile.write{op: activate} needs at least one changed field (legal_name, nmls_id, toll_free_phone, servicer_address, exclusive_address, remittance_address, portal_url, counselor_url, hud_phone, hours, languages, tin)");
  // the activation's decision record is minted first so `servicer_profile.activated{version}` carries its id (T13) and the version row names it (`approved_by_decision_id`)
  const decisionId = randomUUID();
  const v = await activateServicerProfile(q, ctx.events, { ...(str(i, "party_id") ? { party_id: str(i, "party_id") } : {}), effective_from: effectiveFrom, by: ctx.actor, today, decision_id: decisionId, fields: fields as Parameters<typeof activateServicerProfile>[2]["fields"] });
  const changed = Object.keys(fields).filter((k) => k !== "tin");
  const d = cashieringDecision({ subject: { kind: "servicer_profile", id: v.id }, action: "servicer_profile.activate", inputs: { effective_from: effectiveFrom, changed }, outputs: { version: v.version, status: v.status }, rule_set: RULE_SETS.schedule, rationale: `servicer profile version ${v.version} activated by compliance effective ${effectiveFrom}; notices render from it as of that date (rule 9)` });
  ctx.decide({ id: decisionId, agent: CASHIERING_AGENT_NAME, action: d.action, rationale: d.rationale, ruleSetVersion: RULE_SETS.schedule, subject: d.subject, ruleCode: d.ruleCode, modelVersion: d.modelVersion, promptVersion: d.promptVersion, confidence: d.confidence, approvedBy: ctx.actor.id, ...(ctx.actor.role ? { approvedRole: ctx.actor.role } : {}) });
  return { profile_id: v.id, version: v.version, effective_from: v.effective_from, status: v.status, changed, legal_name: v.legal_name, exclusive_address: v.exclusive_address, decision_id: decisionId };
}

export const TOOLS_35_5: readonly ToolDef[] = defineTools(CASHIERING_PROCESS, CASHIERING_AGENT_NAME, [
  { name: "installments.write", kind: "act", ruleSetVersion: RULE_SETS.schedule, guardrails: [NO_MONEY_FIELD], handler: compute(installmentsWrite),
    decision: () => null },   // the run's decision is written by the handler (pre-minted so `installment_schedule_runs.decision_id` names it)
  { name: "installments.reproject", kind: "act", ruleSetVersion: RULE_SETS.schedule, guardrails: [NO_MONEY_FIELD], handler: compute(installmentsReproject),
    decision: () => null },   // as above
  { name: "installments.read", kind: "read", guardrails: [NO_MONEY_FIELD], handler: compute(async (i, ctx) => { const q = txOf(ctx); const loanId = loanIdOf(i, ctx); const rows = await readInstallments(q, loanId, { ...(str(i, "from") ? { from: D(str(i, "from")) } : {}), ...(str(i, "through") ? { through: D(str(i, "through")) } : {}) }); return { loan_id: loanId, rows: rows.map((r) => ({ ...r, pi_cents: r.pi_cents.toString(), interest_cents: r.interest_cents.toString(), principal_cents: r.principal_cents.toString(), escrow_cents: r.escrow_cents.toString(), upb_before_cents: r.upb_before_cents?.toString() ?? null, upb_after_cents: r.upb_after_cents?.toString() ?? null })), runs: (await scheduleRuns(q, loanId)).map((r) => ({ ...r, maturity_variance_cents: r.maturity_variance_cents.toString(), pi_cents: r.pi_cents.toString() })) }; }) },
  // rule 6: one loan's day — 2.1 / 2.7 / 2.3's own commands on this command's unit of work, then the unit row and its receipt (cashiering-cycle.ts)
  { name: "cashiering.run_unit", kind: "act", ruleSetVersion: RULE_SETS.allocation, guardrails: [NO_MONEY_FIELD], handler: compute(runCashieringUnit),
    decision: () => null },   // the unit's decision is written by the handler (pre-minted so `cashiering_unit_runs.decision_id` names it; a second run's decision names the existing row)
  { name: "servicing_config.write", kind: "act", ruleSetVersion: RULE_SETS.schedule, guardrails: [NO_MONEY_FIELD], handler: compute(servicingConfigWrite),
    decision: (i, o, ctx) => { const r = out(o); return cashieringDecision({ subject: { kind: "loan_servicing_config", id: String(r["config_id"] ?? "") }, action: "servicing_config.write", loan_id: str(i, "loan_id") || ctx.loanId, inputs: { time_zone: str(i, "time_zone") || null, jurisdiction_state: str(i, "jurisdiction_state") || null }, outputs: { time_zone: r["time_zone"], jurisdiction_state: r["jurisdiction_state"], servicer_profile_id: r["servicer_profile_id"], nsf_fee_allowed: r["nsf_fee_allowed"] }, rule_set: RULE_SETS.schedule, rationale: r["written"] === true ? `configuration written (${String(r["time_zone_source"])}: ${String(r["time_zone"])}, ${String(r["jurisdiction_state"])}) — rule 9` : `no write: ${String(r["reason"])}` }); } },
  { name: "servicer_profile.write", kind: "act", ruleSetVersion: RULE_SETS.schedule, humanOnly: true, humanRoles: ["compliance"], guardrails: [NO_MONEY_FIELD, never("PROFILE_ACTIVATION_IS_COMPLIANCE", "35.5 rule 9: 'Activating a profile version needs `compliance` and writes a decision'", (i) => (str(i, "op") || "activate") === "activate" && has(i, "approved_by") && !has(i, "effective_from"), "an activation names its effective date; the approval is the decision record this command writes, never an asserted approver")],
    handler: compute(servicerProfileWrite),
    decision: () => null },   // the activation's decision is written by the handler (pre-minted so the event carries its id)
  { name: "writeDecision", kind: "act", ruleSetVersion: RULE_SETS.schedule, guardrails: [NO_MONEY_FIELD], handler: decision() },
]);
