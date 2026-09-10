/**
 * §5.2 tools — Remittance of P&I (`custodial-recon`; the calculations and CRS batch preparation the spec gives
 * `investor-reporting` run through the same tool strings). Every tool string is one spec/registry/agents.json names for
 * 5.2, via `defineTools("5.2", "custodial-recon", defs)` from ../tools.ts; src/app/tools.test.ts refuses the rest. The
 * section's original 5.2 block moved here from ./section05.ts. Spread by ./index.ts (TOOLS_5_2).
 *
 * The handlers are thin shells over src/domain/investor/ops-5-2.ts, which owns the event vocabulary the 5.2 timer rows
 * arm on and are satisfied by:
 *   buildCrsBatch{op}: `sweep` (daily 15:00 ET `$2,500` sweep → `custodial.aa_sweep`, `crs_batches.prepared` + the
 *     16:00 ET upload task), `catch_up` (BD1 prior-month catch-up), `special` (3xx / shortage 001 lines), `compute`
 *     (accepted 5.1 event → `remittance_calculations` row → `remittance_calculations.computed`), `open_period` /
 *     `close_period` / `month_end` (the remittance calendar → `investor_reporting_periods.opened{remittance_type, cycle}`,
 *     `remittance.draft.scheduled`, `investor_reporting_periods.closed`, `period.month_end`), `instruction`
 *     (drafting-instruction change → `crs.instruction.needed` + the 20:00 ET portal task);
 *   openPortalTask: opens the `fnma_portal_operator` work item; `{op=complete}` closes it with the evidence capture and
 *     emits the task's own event — `crs_batches.upload_confirmed` + `remittances.instructed` per accepted line (the CRS
 *     Draft Request Report detail export parsed), `crs.instruction.confirmed`, or the Connect pull's draft notifications;
 *   pullDraftNotifications{op}: `pull` (Loan-Level Draft Notifications API / Connect rows validated →
 *     `fnma.draft_notification.received{kind}`), `reconcile` (rule 8 → `.reconciled`, `.reviewed` for a pre-draft), `list`;
 *   matchBankDebits{op}: `match` (bank debit ↔ remittance → `remittances.drafted{reporting}`, ledger rule, the rule 11
 *     compensatory-fee instance on a late settlement), `receipt` (a custodial credit identified as short-sale / settlement
 *     proceeds → `shortsale.proceeds.received` / `settlement.received`);
 *   explainVariance{op}: classification (decision record; officer above the Agents-paragraph thresholds), `schedule3`
 *     (Form 472 → `fnma.shortage_surplus.shortage_confirmed{reconciled=false}` / `.surplus_identified`), `resolve`;
 *   postLedger{op}: balanced entry sets through commands only; `fund_draft` = rule 7's T−1 16:00 ET funding check →
 *     `custodial.funding.verified{covered}`, `remittances.funded{remittance_type, cycle}`, the `advance` ledger set,
 *     `officer` when the corporate facility is exhausted.
 * Guardrails encode the Agents paragraph verbatim: custodial↔corporate money only through `advance`/`fee_sweep` with the
 * $250,000 / $1,000,000 dual-control thresholds; no CRS cancel after 16:00 ET T−1; never T&I funds for P&I drafts;
 * variance > $500 per loan or > $5,000 per draft code with `unknown` classification → `officer`; plus the shared 5.4
 * Stop Advance guards.
 */
import { defineTools, compute, decision, escalate, guard, never, needsRole, cents, abs, str, num, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { CommandRefused, type CommandContext } from "../commands.ts";
import { hasRole } from "../roles.ts";
import type { EntrySetInput } from "../../kernel/ledger/ledger.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, fannieEt } from "../../kernel/calendar/business.ts";
import { zonedEpochMs, wallClock, toIso } from "../../kernel/calendar/zoned.ts";
import { classifyVariance, fundingDecision, crsAaRequest } from "../../domain/investor/remittance.ts";
import { ET, reconcileDraftDebit, compensatoryFeeInstance } from "../../domain/investor/ops.ts";
import {
  typeCode, aaSweep, monthEnd, openRemittancePeriod, closeRemittancePeriod, recordRemittanceCalculation, prepareCrsBatch, confirmCrsUpload, duplicate001, crsSettlementDate, crsInstructionNeeded, crsInstructionConfirmed,
  fundDraft, validateDraftNotification, ingestDraftNotification, reconcileDraftNotification, recordProceedsReceipt, schedule3, resolveShortageSurplus, isLastWorkDayOfMonth, lastDayOf, daysLate, RULE_SET_VERSION,
  type Emitter, type CycleConfig, type Cycle, type RemittanceTypeCode, type RemittanceKind, type CrsLineInput, type CrsResultLine, type DraftNotificationRow, type ExpectedLoanDraft, type AcceptedEventFacts, type Basis,
} from "../../domain/investor/ops-5-2.ts";

const AGENT = "custodial-recon";
const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const optCents = (i: ToolInput, k: string): bigint | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : cents(i[k]));
const optStr = (i: ToolInput, k: string): string | null => (str(i, k) === "" ? null : str(i, k));
const rows = <T>(i: ToolInput, k: string): T[] => { const v = i[k]; if (!Array.isArray(v)) throw new RangeError(`${k} must be an array`); return v as T[]; };
const nowMs = (ctx: CommandContext): number => Date.parse(ctx.now);
const loanOf = (i: ToolInput, ctx: CommandContext): string => (typeof i.loan_id === "string" && i.loan_id ? i.loan_id : ctx.loanId);
const isoDate = (s: string): s is PlainDate => /^\d{4}-\d{2}-\d{2}$/.test(s);
const em = (ctx: CommandContext): Emitter => ({ events: ctx.events, actor: ctx.actor, now: ctx.now });
const servicerOf = (i: ToolInput): string => { const s = str(i, "servicer_number"); if (!/^\d{9}$/.test(s)) throw new RangeError("servicer_number must be the 9-digit Fannie Mae servicer number"); return s; };
const cycleOf = (i: ToolInput, k = "cycle"): Cycle => { const c = str(i, k) || "standard"; if (!["standard", "rpm", "mbs_express", "sixth_day", "mrs"].includes(c)) throw new RangeError(`cycle ${c} is not one of standard/rpm/mbs_express/sixth_day/mrs`); return c as Cycle; };
const KINDS: readonly RemittanceKind[] = ["pi_scheduled", "pi_actual", "payoff", "curtailment", "repurchase", "gfee", "special", "tps_proceeds", "short_sale", "reo_proceeds", "settlement"];
const kindOf = (i: ToolInput, fallback: RemittanceKind): RemittanceKind => { const k = str(i, "kind") || fallback; if (!KINDS.includes(k as RemittanceKind)) throw new RangeError(`kind ${k} is not a remittances.kind`); return k as RemittanceKind; };
/** A handler-level refusal with a typed code: the same `command.refused` audit row the bus writes for a guardrail, then the typed error. */
function refuse(ctx: CommandContext, command: string, code: string, citation: string, reason: string): never {
  ctx.events.append({ type: "command.refused", loanId: ctx.loanId, actor: ctx.actor, payload: { command, code, citation, reason, subject_id: null } });
  throw new CommandRefused(command, code, citation, reason);
}

// ---- shared: ledger entry-set inspection (the Agents-paragraph money guards) ---------------------------------------------
interface AnyLine { readonly account?: { readonly scope?: string; readonly account?: string; readonly custodialAccountId?: string }; readonly amountCents?: unknown }
const linesOf = (i: ToolInput): AnyLine[] => { const s = i.entry_set as { lines?: unknown } | undefined; return Array.isArray(s?.lines) ? (s.lines as AnyLine[]) : []; };
const acct = (l: AnyLine): string => String(l.account?.account ?? "");
const amt = (l: AnyLine): bigint => { try { return cents(l.amountCents); } catch { return 0n; } };
const TI = /custodial_ti|ti_custodial|escrow/i, PI_DRAFT = /fnma_remittance_payable|remittance|pi_custodial|custodial_pi/i, CORPORATE = /corporate|servicer_advance|advance_receivable|servicing_fee_income|gfee_payable|transfer_clearing/i;
const scopeOf = (l: AnyLine): "custodial" | "corporate" | "loan" => (l.account?.scope === "custodial" || l.account?.scope === "corporate" ? l.account.scope : /custodial/i.test(acct(l)) ? "custodial" : CORPORATE.test(acct(l)) ? "corporate" : "loan");
const custodialCorporateTransfer = (i: ToolInput): { cents: bigint; direction: "corporate_to_custodial" | "custodial_to_corporate" } | null => {
  const ls = linesOf(i); const cust = ls.filter((l) => scopeOf(l) === "custodial"), corp = ls.filter((l) => scopeOf(l) === "corporate");
  if (!cust.length || !corp.length) return null;
  return { cents: corp.reduce((s, l) => s + abs(amt(l)), 0n), direction: corp.some((l) => amt(l) < 0n) ? "corporate_to_custodial" : "custodial_to_corporate" };
};
/** Custodial↔corporate transfers already posted today (the $1,000,000 daily dual-control threshold), read from the ledger itself. */
const dailyTransferCents = (ctx: CommandContext): bigint => {
  const today = wallClock(nowMs(ctx), ET).date; let total = 0n;
  for (const set of ctx.ledger.sets()) { if (set.effectiveDate !== today) continue; const cust = set.lines.some((l) => l.account.scope === "custodial"), corp = set.lines.filter((l) => l.account.scope === "corporate"); if (cust && corp.length) total += corp.reduce((s, l) => s + abs(l.amountCents), 0n); }
  return total;
};
const sdaActive = (ctx: CommandContext, loanId: string): boolean => { const evs = ctx.events.byLoan(loanId).filter((e) => e.type.startsWith("sda_status.")); const last = evs[evs.length - 1]; return last?.type === "sda_status.active"; };
const recoveryDraftSettled = (ctx: CommandContext, loanId: string): boolean => ctx.events.byLoan(loanId).some((e) => e.type === "remittances.drafted" && (e.payload as { sda_recovery?: unknown }).sda_recovery === true);
const fundOp = (i: ToolInput): boolean => i.op === "fund_draft";
const fundShortfall = (i: ToolInput): ReturnType<typeof fundingDecision> => fundingDecision(cents(i.expected_draft_cents), cents(i.custodial_available_cents));
const noTiForPi = guard("NO_TI_FOR_PI", "5.2 guardrail: never uses escrow (T&I) funds for P&I drafts", (i) => {
  if (fundOp(i)) return TI.test(str(i, "source_account")) || TI.test(str(i, "custodial_account_id")) ? "P&I drafts are never funded from the T&I custodial account" : undefined;
  const ls = linesOf(i); const creditsTi = ls.some((l) => TI.test(acct(l)) && amt(l) < 0n); const piDraft = ls.some((l) => PI_DRAFT.test(acct(l)) && !TI.test(acct(l)) && amt(l) > 0n);
  return creditsTi && piDraft ? "P&I drafts are never funded from the T&I custodial account" : undefined; });
const advanceCommandsOnly = guard("ADVANCE_COMMANDS_ONLY", "5.2 guardrail: cannot move money between custodial and corporate accounts except through the advance/fee_sweep commands", (i) => (!fundOp(i) && custodialCorporateTransfer(i) !== null && !["advance", "fee_sweep"].includes(str(i, "transfer_kind")) ? "custodial↔corporate movements go through the `advance`/`fee_sweep` commands (declare transfer_kind)" : undefined));
const dualControl = guard("DUAL_CONTROL_250K", "5.2 guardrail: single custodial↔corporate transfer > $250,000 or daily > $1,000,000 requires officer approval", (i, ctx) => {
  const t = fundOp(i) ? (fundShortfall(i).advance ? { cents: fundShortfall(i).shortfall_cents, direction: "corporate_to_custodial" as const } : null) : custodialCorporateTransfer(i);
  if (!t) return undefined; const daily = dailyTransferCents(ctx);
  return (t.cents > 25_000_000n || daily + t.cents > 100_000_000n) && !hasRole(ctx.actor, ["officer"]) ? `dual control: ${t.direction} of ${t.cents}¢ (today ${daily}¢ already) needs an officer; requires officer` : undefined; });
const noAdvanceOnStopAdvance = guard("NO_ADVANCE_ON_STOP_ADVANCE", "5.4 guardrail (shared): never fund an advance for a loan Fannie Mae has flagged Stop Advance", (i, ctx) => {
  const t = custodialCorporateTransfer(i); const advance = fundOp(i) ? typeof i.loan_id === "string" && fundShortfall(i).advance : (t !== null && t.direction === "corporate_to_custodial") || linesOf(i).some((l) => /servicer_advance_receivable|advance_receivable/i.test(acct(l)) && amt(l) > 0n);
  return advance && sdaActive(ctx, loanOf(i, ctx)) ? "Fannie Mae has set Stop Advance for the loan: no delinquency advance is funded (F-1-20)" : undefined; });
const holdPiUntilRecoveryDraft = guard("HOLD_PI_UNTIL_RECOVERY_DRAFT", "5.4 guardrail (shared): never release custodial P&I collected on an SDA loan before Fannie Mae's recovery draft settles", (i, ctx) => {
  const ls = linesOf(i); const release = ls.some((l) => /custodial_pi/i.test(acct(l)) && amt(l) < 0n) && ls.some((l) => scopeOf(l) === "corporate" && amt(l) > 0n); const loan = loanOf(i, ctx);
  return release && sdaActive(ctx, loan) && !recoveryDraftSettled(ctx, loan) ? "collected P&I stays in custodial_pi_cash until Fannie Mae's Stop Advance recovery draft settles" : undefined; });

// ---- portal tasks (fnma_portal_operator) ----------------------------------------------------------------------------------
function openPortal(rt: ToolRuntime, ctx: CommandContext, t: { task_type: "crs.upload" | "crs.instruction" | "connect.pull"; due_at: string; servicer_number: string; batch_id?: string; instruction_id?: string; loan_id?: string; package?: Record<string, unknown> }): { portal_task_id: string; owner_role: string; due_at: string } {
  const e = rt.escalations.open({ kind: "human_portal_task", severity: "sev2", ...(t.batch_id ? { batchId: t.batch_id } : {}), ...(t.loan_id ? { loanId: t.loan_id } : {}), payload: { task_type: t.task_type, due_at: t.due_at, servicer_number: t.servicer_number, batch_id: t.batch_id ?? null, instruction_id: t.instruction_id ?? null, ...(t.package ?? {}) } }, ctx.actor);
  rt.store.put("portal_tasks", e.id, { task_type: t.task_type, due_at: t.due_at, servicer_number: t.servicer_number, batch_id: t.batch_id ?? null, instruction_id: t.instruction_id ?? null, loan_id: t.loan_id ?? null, status: "open", opened_at: ctx.now }, ctx.actor, ctx.now);
  return { portal_task_id: e.id, owner_role: e.ownerRole, due_at: t.due_at };
}
/** Prepares one CRS batch file for the lines (one servicer number / settlement date), stores it, and opens the 16:00 ET upload task. */
function batchFor(rt: ToolRuntime, ctx: CommandContext, lines: readonly CrsLineInput[], preparedAtMs: number): Record<string, unknown> {
  const n = rt.store.list("crs_batches").length + 1;
  const id = `crs-${lines[0]!.servicer_number}-${lines[0]!.settlement_date}-${n}`;
  const b = prepareCrsBatch(em(ctx), { batch_id: id, lines, prepared_at_ms: preparedAtMs });
  rt.store.put("crs_batches", id, { servicer_number: lines[0]!.servicer_number, settlement_date: b.settlement_date, line_count: b.line_count, total_cents: b.total_cents, prepared_at: toIso(preparedAtMs), upload_due_at: b.upload_due_at, status: "prepared", text: b.text, manifest: b.manifest, lines: [...lines] }, ctx.actor, ctx.now);
  for (const l of lines) rt.store.put("remittances", l.remittance_id, { crs_batch_id: id, settlement_date: l.settlement_date, status: "computed" }, ctx.actor, ctx.now);
  const task = openPortal(rt, ctx, { task_type: "crs.upload", due_at: b.upload_due_at, servicer_number: lines[0]!.servicer_number, batch_id: id, package: { line_count: b.line_count, total_cents: b.total_cents, settlement_date: b.settlement_date } });
  rt.store.put("crs_batches", id, { portal_task_id: task.portal_task_id }, ctx.actor, ctx.now);
  return { batch_id: id, text: b.text, manifest: b.manifest, line_count: b.line_count, total_cents: b.total_cents, settlement_date: b.settlement_date, upload_due_at: b.upload_due_at, portal_task_id: task.portal_task_id, portal_task_due_at: task.due_at, portal_task_due_ms: Date.parse(task.due_at), remittance_ids: lines.map((l) => l.remittance_id) };
}
function existingRequests(rt: ToolRuntime): { remittance_code: string; servicer_number: string; settlement_date: string; status: string }[] {
  return rt.store.list("remittances").map((r) => ({ remittance_code: String(r.data.remittance_code ?? ""), servicer_number: String(r.data.servicer_number ?? ""), settlement_date: String(r.data.settlement_date ?? ""), status: String(r.data.status ?? "") }));
}

// ---- buildCrsBatch ops -------------------------------------------------------------------------------------------------------
/** The A/A sweep (15:00 ET daily; `catch_up` on BD1 for the prior month) → `custodial.aa_sweep`, then the 001 batch when the F-1-20 rule instructs. */
function sweepOp(i: ToolInput, ctx: CommandContext, rt: ToolRuntime, catchUp: boolean): unknown {
  const servicer = servicerOf(i);
  const sweepAt = typeof i.sweep_at === "string" && i.sweep_at !== "" ? Date.parse(i.sweep_at) : i.today !== undefined ? zonedEpochMs(date(i, "today"), catchUp ? "09:00" : "15:00", ET) : nowMs(ctx);
  const on = wallClock(sweepAt, ET).date;
  const net = cents(catchUp ? i.unremitted_cents ?? i.net_collected_cents : i.net_collected_cents);
  const lastWorkDay = catchUp ? true : i.last_work_day_of_month !== undefined ? flag(i, "last_work_day_of_month") : isLastWorkDayOfMonth(on);
  const period = catchUp ? (optStr(i, "activity_period") ?? (() => { const p = wallClock(sweepAt, ET).date; const [y, m] = [Number(p.slice(0, 4)), Number(p.slice(5, 7))]; return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; })()) : optStr(i, "activity_period") ?? undefined;
  const s = aaSweep(em(ctx), { sweep_at_ms: sweepAt, net_collected_cents: net, servicer_number: servicer, last_work_day_of_month: lastWorkDay, ...(period ? { activity_period: period } : {}) });
  if (!s.instruct || !s.line) return { ...s, batch_id: null, carried_to_next_sweep: net > 0n };
  const duplicate = duplicate001(existingRequests(rt), s.line) || (flag(i, "existing_request_same_settlement") && str(i, "existing_status") !== "failed");
  if (duplicate) refuse(ctx, "buildCrsBatch", "NO_DUPLICATE_001", "5.2 edge case: a second 001 request for the same servicer number/settlement date is blocked unless the first failed", `a CRS 001 request for ${servicer} settling ${s.line.settlement_date} already exists (operator confirmation screenshot required)`);
  const remId = `rem-aa-${servicer}-${s.line.settlement_date}-${rt.store.list("remittances").length + 1}`;
  rt.store.put("remittances", remId, { servicer_number: servicer, remittance_type: "aa", remittance_code: "001", kind: "pi_actual", initiator: "servicer", amount_expected_cents: net, settlement_date: s.line.settlement_date, activity_period: s.activity_period, status: "computed", created_at: ctx.now }, ctx.actor, ctx.now);
  const line: CrsLineInput = { remittance_id: remId, servicer_number: servicer, remittance_code: "001", amount_cents: net, settlement_date: s.line.settlement_date, remittance_type: "aa", kind: "pi_actual", activity_period: s.activity_period };
  return { ...s, ...batchFor(rt, ctx, [line], Math.min(s.prepare_by_ms, Math.max(sweepAt, nowMs(ctx)))), prepare_by_ms: s.prepare_by_ms, catch_up: catchUp };
}
/** Special remittances: the 3xx lines of a recorded receipt (`matchBankDebits{op=receipt}`) or explicit lines; a shortage 001 (rule 9); CRS settlement-date rule for the request time. */
function specialOp(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  const servicer = servicerOf(i);
  const requestAt = typeof i.request_at === "string" && i.request_at !== "" ? Date.parse(i.request_at) : nowMs(ctx);
  const settlement = optDate(i, "settlement_date") ?? crsSettlementDate(requestAt);
  const kind = kindOf(i, "special");
  const receipt = optStr(i, "remittance_id") ? rt.store.get("remittances", str(i, "remittance_id"))?.data : undefined;
  const loanId = optStr(i, "loan_id") ?? (typeof receipt?.loan_id === "string" ? receipt.loan_id : null);
  const fnmaLoan = optStr(i, "fnma_loan_number") ?? (typeof receipt?.fnma_loan_number === "string" ? receipt.fnma_loan_number : null);
  const type = optStr(i, "remittance_type") ? typeCode(str(i, "remittance_type")) : typeof receipt?.remittance_type === "string" ? typeCode(receipt.remittance_type) : null;
  const explicit = Array.isArray(i.lines) ? rows<{ remittance_code: string; amount_cents: unknown }>(i, "lines").map((l) => ({ remittance_code: String(l.remittance_code), amount_cents: cents(l.amount_cents) })) : Array.isArray(receipt?.lines) ? (receipt.lines as { remittance_code: string; amount_cents: bigint }[]) : null;
  const lines: CrsLineInput[] = kind === "pi_actual" && str(i, "reason") === "shortage"
    ? [{ remittance_id: `rem-shortage-${servicer}-${str(i, "period") || settlement}`, servicer_number: servicer, remittance_code: "001", amount_cents: cents(i.amount_cents), settlement_date: settlement, remittance_type: "aa", kind: "pi_actual", reason: "shortage", activity_period: optStr(i, "period") }]
    : (explicit ?? (() => { throw new RangeError("special remittance needs lines[{remittance_code, amount_cents}] or the remittance_id of a recorded receipt"); })()).map((l, n) => ({ remittance_id: (typeof receipt?.id === "string" ? receipt.id : optStr(i, "remittance_id")) ? `${str(i, "remittance_id")}${n ? `-${l.remittance_code}` : ""}` : `rem-${kind}-${loanId ?? servicer}-${settlement}-${l.remittance_code}`, servicer_number: servicer, remittance_code: l.remittance_code, amount_cents: l.amount_cents, settlement_date: settlement, fnma_loan_number: fnmaLoan, loan_id: loanId, remittance_type: type, kind, reason: optStr(i, "reason"), activity_period: optStr(i, "period") }));
  for (const l of lines) rt.store.put("remittances", l.remittance_id, { servicer_number: servicer, remittance_type: l.remittance_type ?? null, remittance_code: l.remittance_code, kind: l.kind, initiator: "servicer", amount_expected_cents: l.amount_cents, settlement_date: settlement, loan_id: loanId, fnma_loan_number: fnmaLoan, reason: l.reason ?? null, status: "computed" }, ctx.actor, ctx.now);
  return { ...batchFor(rt, ctx, lines, requestAt), settlement_rule: wallClock(requestAt, ET).hour < 16 ? "next Federal Reserve BD" : "two BD (after 16:00 ET)" };
}
/** Inputs: an accepted 5.1 event creates the `remittance_calculations` row (rule 2 by type) → `remittance_calculations.computed`. */
function computeOp(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  need(i, "activity_period", "remittance_type", "basis", "note_rate", "ptr", "accepted_at");
  const f: AcceptedEventFacts = { loan_id: loanOf(i, ctx), activity_period: str(i, "activity_period"), remittance_type: typeCode(str(i, "remittance_type")), cycle: cycleOf(i), rpm_day: i.rpm_day === undefined ? null : num(i, "rpm_day"), basis: str(i, "basis") as Basis,
    prior_actual_upb_cents: cents(i.prior_actual_upb_cents), prior_scheduled_upb_cents: cents(i.prior_scheduled_upb_cents ?? i.prior_actual_upb_cents), note_rate: str(i, "note_rate"), ptr: str(i, "ptr"), ...(optStr(i, "participation_pct") ? { participation_pct: str(i, "participation_pct") } : {}),
    pi_cents: cents(i.pi_cents), principal_collected_cents: cents(i.principal_collected_cents), ...(i.interest_collected_cents !== undefined ? { interest_collected_cents: cents(i.interest_collected_cents) } : {}), ...(i.months_delinquent !== undefined ? { months_delinquent: num(i, "months_delinquent") } : {}), ...(flag(i, "sda_active") ? { sda_active: true } : {}),
    reporting: str(i, "reporting") === "detailed" ? "detailed" : "summary", phase: str(i, "phase") === "autodraft" ? "autodraft" : "crs", accepted_at: str(i, "accepted_at"), ...(optStr(i, "processed_at") ? { processed_at: str(i, "processed_at") } : {}) };
  const c = recordRemittanceCalculation(em(ctx), f);
  rt.store.put("remittance_calculations", c.calculation_id, { ...c, fnma_loan_number: optStr(i, "fnma_loan_number"), servicer_number: optStr(i, "servicer_number"), computed_at: ctx.now }, ctx.actor, ctx.now);
  if (c.draft_on && c.phase === "autodraft") rt.store.put("remittances", `rem-${c.loan_id}-${c.activity_period}-autodraft`, { loan_id: c.loan_id, remittance_type: "aa", remittance_code: null, kind: "pi_actual", initiator: "fnma", amount_expected_cents: c.remittance_cents, draft_date: c.draft_on, activity_period: c.activity_period, cycle: "standard", status: "computed" }, ctx.actor, ctx.now);
  return c;
}
/** The remittance calendar: period open per cycle (expected draft = Σ `remittance_calculations` for the cycle unless given), period close, month end. */
function openPeriodOp(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  need(i, "month_of"); const servicer = servicerOf(i); const monthOf = date(i, "month_of"); const period = monthOf.slice(0, 7);
  const cycles: CycleConfig[] = rows<Record<string, unknown>>(i, "cycles").map((c) => { const type = typeCode(String(c.remittance_type ?? "")); const cycle = cycleOf(c as ToolInput); const sum = rt.store.list("remittance_calculations", (d) => d.activity_period === period && d.remittance_type === type && d.cycle === cycle).reduce((s, r) => s + cents(r.data.remittance_cents), 0n);
    return { remittance_type: type, cycle, rpm_day: c.rpm_day === undefined || c.rpm_day === null ? null : Number(c.rpm_day), expected_cents: c.expected_cents === undefined || c.expected_cents === null ? sum : cents(c.expected_cents), custodial_account_id: typeof c.custodial_account_id === "string" ? c.custodial_account_id : null }; });
  const out = openRemittancePeriod(em(ctx), { month_of: monthOf, servicer_number: servicer, cycles });
  for (const s of out) if (s.draft_date) rt.store.put("remittances", `rem-${s.subject.id}`, { servicer_number: servicer, remittance_type: s.remittance_type, remittance_code: s.crs_code, kind: s.remittance_type === "aa" ? "pi_actual" : "pi_scheduled", initiator: "fnma", amount_expected_cents: s.expected_cents, draft_date: s.draft_date, activity_period: s.period, cycle: s.cycle, custodial_account_id: cycles.find((c) => c.remittance_type === s.remittance_type && c.cycle === s.cycle)?.custodial_account_id ?? null, status: "computed" }, ctx.actor, ctx.now);
  return { period, schedules: out.map((s) => ({ ...s, remittance_id: s.draft_date ? `rem-${s.subject.id}` : null })) };
}
function instructionOp(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  need(i, "remittance_code", "bank_aba", "bank_account", "effective_date"); const servicer = servicerOf(i);
  const id = optStr(i, "instruction_id") ?? `crsi-${servicer}-${str(i, "remittance_code")}-${str(i, "effective_date")}`;
  const r = crsInstructionNeeded(em(ctx), { instruction_id: id, servicer_number: servicer, remittance_code: str(i, "remittance_code"), bank_aba: str(i, "bank_aba"), bank_account: str(i, "bank_account"), effective_date: date(i, "effective_date") });
  rt.store.put("crs_instructions", id, { servicer_number: servicer, remittance_code: str(i, "remittance_code"), bank_aba: str(i, "bank_aba"), bank_account_last4: str(i, "bank_account").slice(-4), effective_date: str(i, "effective_date"), enter_by_at: r.enter_by_at, status: "needed" }, ctx.actor, ctx.now);
  const task = openPortal(rt, ctx, { task_type: "crs.instruction", due_at: r.enter_by_at, servicer_number: servicer, instruction_id: id, package: { remittance_code: str(i, "remittance_code"), effective_date: str(i, "effective_date"), contacts_required: 2 } });
  rt.store.put("crs_instructions", id, { portal_task_id: task.portal_task_id }, ctx.actor, ctx.now);
  return { instruction_id: id, enter_by_at: r.enter_by_at, ...task };
}

// ---- openPortalTask{op=complete} ----------------------------------------------------------------------------------------------
function ingestRows(i: ToolInput, ctx: CommandContext, rt: ToolRuntime, source: "api" | "connect_report"): unknown[] {
  const out: unknown[] = [];
  for (const raw of rows<Record<string, unknown>>(i, "notifications")) {
    const row: DraftNotificationRow = validateDraftNotification({ source, ...raw });
    const r = ingestDraftNotification(em(ctx), row);
    rt.store.put("draft_notifications", row.notification_id, { ...row, received_at: ctx.now, review_by_at: r.review_by_at, status: "received" }, ctx.actor, ctx.now);
    out.push({ ...row, review_by_at: r.review_by_at });
  }
  if (!out.length) throw new RangeError("no draft notifications to ingest");
  return out;
}
function completePortalTask(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  need(i, "portal_task_id", "evidence_document_id");
  const id = str(i, "portal_task_id"); const task = rt.store.require("portal_tasks", id).data;
  rt.escalations.complete(id, ctx.actor, str(i, "evidence_document_id"));
  rt.store.put("portal_tasks", id, { status: "completed", completed_at: ctx.now, completed_by: ctx.actor.id, evidence_document_id: str(i, "evidence_document_id") }, ctx.actor, ctx.now);
  ctx.events.append({ type: "human_portal_task.completed", aggregate: { kind: "escalation", id }, actor: ctx.actor, payload: { task: String(task.task_type), evidence_document_id: str(i, "evidence_document_id"), completed_by: ctx.actor.id, batch_id: task.batch_id ?? null, instruction_id: task.instruction_id ?? null } });
  switch (String(task.task_type)) {
    case "crs.upload": {
      const batchId = String(task.batch_id); const batch = rt.store.require("crs_batches", batchId).data;
      const lines = batch.lines as CrsLineInput[];
      const result: CrsResultLine[] = Array.isArray(i.crs_result) ? rows<CrsResultLine>(i, "crs_result") : flag(i, "all_accepted") ? lines.map((l) => ({ remittance_id: l.remittance_id, accepted: true })) : (() => { throw new RangeError("the CRS confirmation (crs_result[{remittance_id, accepted, reject_reason}] from the Draft Request Report detail export) is required, or all_accepted"); })();
      const c = confirmCrsUpload(em(ctx), { batch_id: batchId, lines, result, uploaded_at: ctx.now, confirmation_document_id: str(i, "evidence_document_id") });
      for (const rid of c.accepted) rt.store.put("remittances", rid, { status: "instructed", instructed_at: c.uploaded_at }, ctx.actor, ctx.now);
      for (const rid of c.failed) rt.store.put("remittances", rid, { status: "failed", crs_batch_id: null }, ctx.actor, ctx.now);
      rt.store.put("crs_batches", batchId, { status: c.failed.length ? (c.accepted.length ? "partial" : "failed") : "uploaded", uploaded_at: c.uploaded_at, crs_result: result, confirmation_document_id: str(i, "evidence_document_id") }, ctx.actor, ctx.now);
      return { task: "crs.upload", batch_id: batchId, ...c, re_batch: c.failed };
    }
    case "crs.instruction": {
      const iid = String(task.instruction_id); const inst = rt.store.require("crs_instructions", iid).data;
      crsInstructionConfirmed(em(ctx), { instruction_id: iid, effective_date: D(String(inst.effective_date)), confirmation_document_id: str(i, "evidence_document_id") });
      rt.store.put("crs_instructions", iid, { status: "confirmed", confirmed_at: ctx.now }, ctx.actor, ctx.now);
      return { task: "crs.instruction", instruction_id: iid, effective_date: inst.effective_date };
    }
    case "connect.pull": return { task: "connect.pull", notifications: ingestRows(i, ctx, rt, "connect_report") };
    default: return { task: String(task.task_type), completed: true };
  }
}

// ---- pullDraftNotifications / matchBankDebits / explainVariance / postLedger ops ---------------------------------------------
async function pullOp(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  if (!Array.isArray(i.notifications)) {
    const connect = rt.ports.connect; if (!connect) throw new RangeError("notifications[] (Loan-Level Draft Notifications API rows) are required when no Connect port is wired");
    const asOf = str(i, "as_of") || ctx.now.slice(0, 10);
    const pulled = await connect.pull("remittance_detail_pi", asOf);
    return ingestRows({ ...i, notifications: pulled.rows.map((r) => ({ ...r, source: "connect_report" })) }, ctx, rt, "connect_report");
  }
  return ingestRows(i, ctx, rt, str(i, "source") === "connect_report" ? "connect_report" : "api");
}
function reconcileOp(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  need(i, "notification_id"); const rec = rt.store.require("draft_notifications", str(i, "notification_id")).data as unknown as DraftNotificationRow & { status: string };
  const expected: ExpectedLoanDraft[] = Array.isArray(i.expected) ? rows<Record<string, unknown>>(i, "expected").map((e) => ({ fnma_loan_number: String(e.fnma_loan_number), loan_id: typeof e.loan_id === "string" ? e.loan_id : null, expected_cents: cents(e.expected_cents), ...(e.sda_active === true ? { sda_active: true } : {}), ...(e.recovery === true ? { recovery: true } : {}) }))
    : rt.store.list("remittance_calculations", (d) => d.activity_period === rec.period && typeof d.fnma_loan_number === "string").map((r) => ({ fnma_loan_number: String(r.data.fnma_loan_number), loan_id: String(r.data.loan_id), expected_cents: cents(r.data.remittance_cents), ...(r.data.sda_flag === true ? { sda_active: true } : {}) }));
  const r = reconcileDraftNotification(em(ctx), { notification: rec, expected });
  rt.store.put("draft_notifications", rec.notification_id, { status: rec.kind === "predraft" ? "reviewed" : "reconciled", reconciled_at: ctx.now, variances: r.variances, draft_expectation_cents: r.draft_expectation_cents }, ctx.actor, ctx.now);
  for (const rem of rt.store.list("remittances", (d) => d.activity_period === rec.period && d.initiator === "fnma" && (d.remittance_code === rec.remittance_code || d.draft_date === rec.draft_date))) rt.store.put("remittances", rem.id, { amount_notified_cents: rec.amount_cents, draft_expectation_cents: r.draft_expectation_cents, status: rem.data.status === "computed" ? "notified" : rem.data.status }, ctx.actor, ctx.now);
  let escalation: string | null = null;
  if (r.officer) escalation = rt.escalations.open({ kind: "officer", severity: "sev2", payload: { reason: "5.2 guardrail: draft-notification variance > $500 per loan or > $5,000 per draft code with unknown classification", notification_id: rec.notification_id, unexplained_loans: r.unexplained_loans, variance_cents: r.variance_cents } }, ctx.actor).id;
  return { notification_id: rec.notification_id, kind: rec.kind, ...r, escalation_id: escalation };
}
function matchOp(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  const debits = rows<{ id: string; amount_cents: bigint; date: string; originator: string }>(i, "debits");
  type MatchRem = { id: string; expected_cents: bigint; draft_date: string; custodial_account_id?: string; reporting?: string; loan_id?: string; sda_recovery?: boolean };
  const rem: MatchRem[] = Array.isArray(i.remittances) ? rows<MatchRem>(i, "remittances")
    : rt.store.list("remittances", (d) => typeof d.draft_date === "string" && ["computed", "funded", "instructed", "notified"].includes(String(d.status))).map((r): MatchRem => ({ id: r.id, expected_cents: cents(r.data.draft_expectation_cents ?? r.data.amount_notified_cents ?? r.data.amount_expected_cents), draft_date: String(r.data.draft_date), ...(typeof r.data.custodial_account_id === "string" ? { custodial_account_id: r.data.custodial_account_id } : {}), ...(typeof r.data.reporting === "string" ? { reporting: r.data.reporting } : {}), ...(typeof r.data.loan_id === "string" ? { loan_id: r.data.loan_id } : {}), ...(r.data.sda_recovery === true ? { sda_recovery: true } : {}) }));
  const matched: { debit_id: string; remittance_id: string; status: "matched" | "variance"; variance_cents: bigint; days_late: number; compfee_instance_id: string | null }[] = []; const used = new Set<string>();
  for (const d of debits) {
    if (!/fannie/i.test(d.originator)) continue;
    const onTime = rem.find((r) => !used.has(r.id) && r.draft_date === d.date && (r.expected_cents === d.amount_cents || abs(r.expected_cents - d.amount_cents) <= 100n));
    const late = onTime ?? rem.find((r) => !used.has(r.id) && r.draft_date < d.date && r.expected_cents === d.amount_cents);
    const m = late; if (!m) continue; used.add(m.id);
    const lateDays = daysLate(D(m.draft_date), D(d.date));
    const rec = reconcileDraftDebit({ remittance_id: m.id, expected_cents: m.expected_cents, draft_date: lateDays ? D(d.date) : D(m.draft_date), debit_cents: d.amount_cents, debit_date: D(d.date), originator: d.originator, custodial_account_id: m.custodial_account_id ?? "custodial_pi" });
    if (rec.status === "unmatched") continue;
    const loanId = m.loan_id ?? loanOf(i, ctx);
    let compfee: string | null = null;
    if (lateDays > 0) {   // rule 11: any late draft → compensatory-fee exposure instance + officer
      const prior = rt.store.list("compfee_instances", (c) => typeof c.recorded_at === "string" && c.recorded_at.slice(0, 4) === ctx.now.slice(0, 4)).length;
      const prime = optStr(i, "prime_pct");
      const inst = prime ? compensatoryFeeInstance({ amount_cents: d.amount_cents, days_late: lateDays, prime_pct: prime, prior_instances_within_year: prior }) : null;
      compfee = `cf-${m.id}-${d.date}`;
      rt.store.put("compfee_instances", compfee, { kind: "late_remittance", remittance_id: m.id, amount_cents: d.amount_cents, days_late: lateDays, fee_cents: inst?.fee_cents ?? null, minimum_cents: inst?.minimum_cents ?? null, instance_number: prior + 1, prime_pct: prime, recorded_at: ctx.now }, ctx.actor, ctx.now);
      rt.escalations.open({ kind: "officer", severity: "sev1", loanId, payload: { reason: "5.2 Escalations: compensatory-fee instance (late draft settlement)", remittance_id: m.id, days_late: lateDays, fee_cents: inst?.fee_cents ?? null, instance_number: prior + 1 } }, ctx.actor);
    }
    matched.push({ debit_id: d.id, remittance_id: m.id, status: rec.status, variance_cents: rec.variance_cents, days_late: lateDays, compfee_instance_id: compfee });
    ctx.events.append({ type: "remittances.drafted", loanId, actor: ctx.actor, payload: { remittance_id: m.id, debit_id: d.id, amount_cents: d.amount_cents, draft_date: m.draft_date, debit_date: d.date, reporting: m.reporting ?? "summary", late: lateDays > 0, days_late: lateDays, ...(m.sda_recovery ? { sda_recovery: true } : {}) } });
    ctx.events.append({ type: rec.status === "matched" ? "remittances.matched" : "remittances.variance", loanId, actor: ctx.actor, payload: { remittance_id: m.id, variance_cents: rec.variance_cents } });
    if (rec.entry_set) ctx.ledger.post({ effectiveDate: rec.entry_set.effectiveDate, description: rec.entry_set.description, lines: rec.entry_set.lines.map((l) => ({ account: { scope: "custodial" as const, custodialAccountId: l.account.custodialAccountId, account: l.account.account as "custodial_pi_cash" }, amountCents: l.amountCents, ruleRef: l.ruleRef })) }, ctx.now);
    rt.store.put("remittances", m.id, { status: rec.status, amount_drafted_cents: d.amount_cents, variance_cents: rec.variance_cents, drafted_on: d.date }, ctx.actor, ctx.now);
    if (rec.decision) ctx.decide({ agent: ctx.actor.id, action: rec.decision.action, rationale: `expected ${rec.decision.expected}¢, drafted ${rec.decision.drafted}¢, variance ${rec.decision.variance}¢`, ruleSetVersion: RULE_SET_VERSION, loanId, subject: { kind: "remittance", id: m.id }, confidence: rec.decision.confidence });
  }
  const unmatched = debits.filter((d) => !matched.some((m) => m.debit_id === d.id)).map((d) => d.id);
  if (unmatched.length) rt.escalations.open({ kind: "sev1", payload: { reason: "5.2 rule 8: unmatched Fannie Mae debit(s) on the custodial account", debit_ids: unmatched } }, ctx.actor);
  return { matched, unmatched_debits: unmatched, alert: unmatched.length ? "sev1" : null, ledger_rule: "Dr fnma_remittance_payable / Cr custodial_pi_cash" };
}
function receiptOp(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  need(i, "kind", "amount_cents", "received_on", "remittance_type", "fnma_loan_number"); const servicer = servicerOf(i);
  const kind = str(i, "kind"); if (kind !== "short_sale" && kind !== "settlement") throw new RangeError("receipt kind must be short_sale or settlement (payoff funds are 16.2's, TPS proceeds 15.1's)");
  const loanId = loanOf(i, ctx);
  const p = recordProceedsReceipt(em(ctx), { loan_id: loanId, kind, amount_cents: cents(i.amount_cents), received_on: date(i, "received_on"), sale_closed_on: optDate(i, "sale_closed_on"), contribution_cents: optCents(i, "contribution_cents"), remittance_type: typeCode(str(i, "remittance_type")), cycle: cycleOf(i), rpm_day: i.rpm_day === undefined ? null : num(i, "rpm_day"), servicer_number: servicer, fnma_loan_number: str(i, "fnma_loan_number") });
  rt.store.put("remittances", p.remittance_id, { id: p.remittance_id, servicer_number: servicer, remittance_type: typeCode(str(i, "remittance_type")), remittance_code: p.lines[0]!.remittance_code, kind, initiator: "servicer", amount_expected_cents: cents(i.amount_cents), loan_id: loanId, fnma_loan_number: str(i, "fnma_loan_number"), received_on: str(i, "received_on"), instruct_by: p.instruct_by, instruct_by_at: p.instruct_by_at, lines: p.lines, status: "computed" }, ctx.actor, ctx.now);
  return p;
}
function classifyOp(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  need(i, "expected_cents", "notified_cents");
  const v = classifyVariance(cents(i.expected_cents), cents(i.notified_cents), { ...(flag(i, "sda_active") ? { sda_active: true } : {}), ...(i.sda_credit_cents !== undefined ? { sda_credit_cents: cents(i.sda_credit_cents) } : {}), ...(flag(i, "recovery") ? { recovery: true } : {}), ...(typeof i.code === "string" ? { code: i.code } : {}) });
  const a = abs(v.variance_cents);
  const officer = v.class === "unexplained" && (a > 50_000n || abs(cents(i.draft_code_total_variance_cents)) > 500_000n);
  const escalation = officer ? rt.escalations.open({ kind: "officer", severity: "sev2", loanId: loanOf(i, ctx), payload: { reason: "5.2 guardrail: variance > $500 per loan or > $5,000 per draft code with unknown classification → officer", expected_cents: cents(i.expected_cents), notified_cents: cents(i.notified_cents), variance_cents: v.variance_cents } }, ctx.actor).id : null;
  return { ...v, escalate_officer: officer, escalation_id: escalation, no_advance_transfer: v.draft_expectation_cents === 0n };
}
function schedule3Op(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  need(i, "period"); const servicer = servicerOf(i);
  const prior = rt.store.list("shortage_surplus", (d) => d.servicer_number === servicer && d.status === "open").map((r) => r.data).sort((a, b) => String(b.period).localeCompare(String(a.period)))[0];
  const firstSeen = optDate(i, "surplus_first_seen") ?? (prior && prior.kind === "surplus" && typeof prior.first_seen_on === "string" ? D(prior.first_seen_on) : null);
  const s = schedule3(em(ctx), { servicer_number: servicer, period: str(i, "period"), opening_cents: cents(i.opening_cents), remitted_cents: cents(i.remitted_cents), reported_pi_cents: cents(i.reported_pi_cents), explained_items: Array.isArray(i.explained_items) ? rows<{ kind: string; amount_cents: unknown; note: string }>(i, "explained_items").map((x) => ({ kind: String(x.kind), amount_cents: cents(x.amount_cents), note: String(x.note ?? "") })) : [], surplus_first_seen: firstSeen, prior_open_kind: prior ? (prior.kind as "surplus" | "shortage") : null });
  rt.store.put("shortage_surplus", `${servicer}:${str(i, "period")}`, { servicer_number: servicer, period: str(i, "period"), opening_cents: cents(i.opening_cents), remitted_cents: cents(i.remitted_cents), reported_pi_cents: cents(i.reported_pi_cents), closing_cents: s.closing_cents, explained_items: i.explained_items ?? [], kind: s.kind, unexplained_cents: s.unexplained_cents, first_seen_on: s.first_seen_on, surplus_resolve_due_on: s.surplus_resolve_due_on, artifact: s.artifact, explanation: s.explanation, status: s.kind === "balanced" ? "balanced" : "open" }, ctx.actor, ctx.now);
  if (s.resolved_prior && prior) rt.store.put("shortage_surplus", `${servicer}:${String(prior.period)}`, { status: "resolved", resolved_in_period: str(i, "period") }, ctx.actor, ctx.now);
  return s;
}
function resolveOp(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  need(i, "kind", "period", "form_472_document_id", "explanation"); const servicer = servicerOf(i);
  const kind = str(i, "kind"); if (kind !== "surplus" && kind !== "shortage") throw new RangeError("kind must be surplus or shortage");
  resolveShortageSurplus(em(ctx), { servicer_number: servicer, kind, period: str(i, "period"), form_472_document_id: str(i, "form_472_document_id"), explanation: str(i, "explanation") });
  rt.store.put("shortage_surplus", `${servicer}:${str(i, "period")}`, { status: "resolved", form_472_document_id: str(i, "form_472_document_id"), resolution: str(i, "explanation"), resolved_at: ctx.now }, ctx.actor, ctx.now);
  return { resolved: true, kind, period: str(i, "period") };
}
async function fundDraftOp(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<unknown> {
  need(i, "period", "remittance_type", "draft_date", "custodial_account_id");
  const type: RemittanceTypeCode = typeCode(str(i, "remittance_type")); const cycle = cycleOf(i); const period = str(i, "period");
  const stored = rt.store.get("remittances", optStr(i, "remittance_id") ?? `rem-${period}:${type}:${cycle}`)?.data;
  const expected = optCents(i, "expected_draft_cents") ?? (stored ? cents(stored.draft_expectation_cents ?? stored.amount_notified_cents ?? stored.amount_expected_cents) : (() => { throw new RangeError("expected_draft_cents is required when no remittances row is scheduled for the cycle"); })());
  let available = optCents(i, "custodial_available_cents");
  if (available === null) { const bank = rt.ports.custodialBank; if (!bank) throw new RangeError("custodial_available_cents is required when no custodial bank port is wired"); const st = await bank.intraday(str(i, "custodial_account_id"), ctx.now); available = st.closingLedgerCents ?? st.openingLedgerCents ?? 0n; }
  const atMs = optStr(i, "now") ? Date.parse(str(i, "now")) : nowMs(ctx);
  // the dual-control threshold is re-checked on the figures the handler actually uses (a stored expectation or a bank-feed balance never reaches the input guard)
  const fd = fundingDecision(expected, available);
  if (fd.dual_control && !hasRole(ctx.actor, ["officer"])) refuse(ctx, "postLedger", "DUAL_CONTROL_250K", "5.2 guardrail: single custodial↔corporate transfer > $250,000 or daily > $1,000,000 requires officer approval", `dual control: corporate_to_custodial advance of ${fd.shortfall_cents}¢ needs an officer; requires officer`);
  const r = fundDraft(em(ctx), { period, remittance_type: type, cycle, draft_date: date(i, "draft_date"), expected_draft_cents: expected, custodial_available_cents: available, facility_available_cents: cents(i.facility_available_cents), custodial_account_id: str(i, "custodial_account_id"), loan_id: optStr(i, "loan_id"), kind: kindOf(i, type === "aa" ? "pi_actual" : "pi_scheduled"), at_ms: atMs });
  const set = r.entry_set ? ctx.ledger.post(r.entry_set as EntrySetInput, ctx.now) : null;
  const remId = optStr(i, "remittance_id") ?? `rem-${period}:${type}:${cycle}`;
  if (r.status === "funded") rt.store.put("remittances", remId, { status: "funded", funded_at: r.funded_at, advance_cents: r.advance.amount_cents, draft_date: str(i, "draft_date"), remittance_type: type, cycle, activity_period: period }, ctx.actor, ctx.now);
  const escalation = r.status === "escalated" ? rt.escalations.open({ kind: "officer", severity: "sev1", ...(optStr(i, "loan_id") ? { loanId: str(i, "loan_id") } : {}), payload: { reason: "5.2 Escalations: funding shortfall the corporate facility cannot cover", period, remittance_type: type, cycle, draft_date: str(i, "draft_date"), shortfall_cents: r.advance.amount_cents, facility_available_cents: cents(i.facility_available_cents), funded_by_at: toIso(r.advance.funded_by_ms) } }, ctx.actor) : null;
  return { ...r.advance, status: r.status, funded_at: r.funded_at, entry_set_id: set?.id ?? null, ledger: r.advance.ledger, escalation_id: escalation?.id ?? null, escalation: r.advance.escalation, subject: r.subject, remittance_id: remId, source_account: str(i, "source_account") || "corporate" };
}

// ---- the tools -----------------------------------------------------------------------------------------------------------------
const buildCrsBatch: Omit<ToolDef, "process" | "agent"> = { name: "buildCrsBatch", kind: "write", ruleSetVersion: RULE_SET_VERSION,
  handler: compute((i, ctx, rt) => {
    switch (str(i, "op") || "sweep") {
      case "sweep": { if (i.today === undefined && i.sweep_at === undefined && i.net_collected_cents === undefined) throw new RangeError("sweep needs today (or sweep_at), net_collected_cents and servicer_number"); return sweepOp(i, ctx, rt, false); }
      case "catch_up": return sweepOp(i, ctx, rt, true);
      case "special": return specialOp(i, ctx, rt);
      case "compute": return computeOp(i, ctx, rt);
      case "open_period": return openPeriodOp(i, ctx, rt);
      case "close_period": { need(i, "month_of"); return closeRemittancePeriod(em(ctx), { month_of: date(i, "month_of"), servicer_number: servicerOf(i), ...(i.checklist_complete !== undefined ? { checklist_complete: flag(i, "checklist_complete") } : {}) }); }
      case "month_end": { const servicer = servicerOf(i); const end = optDate(i, "period_end") ?? lastDayOf(str(i, "period") || ctx.now.slice(0, 7)); const r = monthEnd(em(ctx), { period_end: end, servicer_number: servicer, unremitted_cents: cents(i.unremitted_cents) }); return { ...r, catch_up_request: r.aa_collections_unremitted ? crsAaRequest(cents(i.unremitted_cents), addBusinessDays(end, 1, fannieEt), true) : null }; }
      case "instruction": return instructionOp(i, ctx, rt);
      case "cancel": throw new RangeError("a CRS request is deleted in CRS by the operator before 16:00 ET T−1 (portal task), never by the batch builder");
      default: throw new RangeError(`buildCrsBatch op ${str(i, "op")} is not one of sweep/catch_up/special/compute/open_period/close_period/month_end/instruction`);
    }
  }),
  decision: (i, out) => ({ action: `buildCrsBatch:${str(i, "op") || "sweep"}`, rationale: str(i, "rationale") || `5.2 ${str(i, "op") || "sweep"} for servicer ${str(i, "servicer_number") || "?"}${(out as { batch_id?: string } | null)?.batch_id ? ` → batch ${(out as { batch_id: string }).batch_id}` : ""}` }),
  guardrails: [guard("NO_CANCEL_AFTER_1600_T1", "5.2 guardrail: cannot cancel a CRS request after 16:00 ET T−1", (i, ctx) => (i.op === "cancel" && typeof i.settlement_date === "string" && isoDate(i.settlement_date) && nowMs(ctx) > zonedEpochMs(addBusinessDays(D(i.settlement_date), -1, fannieEt), "16:00", ET) ? "CRS requests are final after 16:00 ET the business day before settlement (CRS processes them then)" : undefined)),
    never("NO_DUPLICATE_001", "5.2 edge case: a second 001 request for the same servicer number/settlement date is blocked unless the first failed", (i) => flag(i, "existing_request_same_settlement") && str(i, "existing_status") !== "failed", "duplicate CRS 001 for the settlement date")] };

const openPortalTask: Omit<ToolDef, "process" | "agent"> = { name: "openPortalTask", kind: "act", ruleSetVersion: RULE_SET_VERSION,
  handler: compute((i, ctx, rt) => {
    if (i.op === "complete") return completePortalTask(i, ctx, rt);
    const taskType = str(i, "task_type");
    if (taskType === "crs.upload" || taskType === "crs.instruction" || taskType === "connect.pull") { need(i, "due_at"); return openPortal(rt, ctx, { task_type: taskType, due_at: str(i, "due_at"), servicer_number: str(i, "servicer_number"), ...(optStr(i, "batch_id") ? { batch_id: str(i, "batch_id") } : {}), ...(optStr(i, "instruction_id") ? { instruction_id: str(i, "instruction_id") } : {}), package: (i.payload as Record<string, unknown> | undefined) ?? { reason: i.reason ?? null } }); }
    return escalate("human_portal_task")(i, ctx, rt);
  }),
  decision: (i) => ({ action: i.op === "complete" ? "openPortalTask:complete" : "openPortalTask", rationale: str(i, "reason") || (i.op === "complete" ? `fnma_portal_operator completed ${str(i, "portal_task_id")} with evidence ${str(i, "evidence_document_id")}` : "fnma_portal_operator: CRS upload/instruction or Connect pull") }) };

const pullDraftNotifications: Omit<ToolDef, "process" | "agent"> = { name: "pullDraftNotifications", kind: "write", ruleSetVersion: RULE_SET_VERSION,
  handler: compute((i, ctx, rt) => {
    switch (str(i, "op") || "pull") {
      case "pull": return pullOp(i, ctx, rt);
      case "reconcile": return reconcileOp(i, ctx, rt);
      case "list": return rt.store.list("draft_notifications", (d) => !i.period || d.period === i.period).map((r) => ({ id: r.id, ...r.data }));
      default: throw new RangeError(`pullDraftNotifications op ${str(i, "op")} is not one of pull/reconcile/list`);
    }
  }),
  decision: (i, out) => (str(i, "op") === "list" ? null : { action: `pullDraftNotifications:${str(i, "op") || "pull"}`, rationale: str(i, "op") === "reconcile" ? `classification=${((out as { variances?: { class: string }[] })?.variances ?? []).map((v) => v.class).join(",") || "none"} draft_expectation=${String((out as { draft_expectation_cents?: bigint })?.draft_expectation_cents ?? "")}` : `draft notifications ingested (${str(i, "source") || "api"})` }) };

const matchBankDebits: Omit<ToolDef, "process" | "agent"> = { name: "matchBankDebits", kind: "write", ruleSetVersion: RULE_SET_VERSION,
  handler: compute((i, ctx, rt) => {
    switch (str(i, "op") || "match") {
      case "match": return matchOp(i, ctx, rt);
      case "receipt": return receiptOp(i, ctx, rt);
      default: throw new RangeError(`matchBankDebits op ${str(i, "op")} is not one of match/receipt`);
    }
  }),
  decision: (i, out) => ({ action: `matchBankDebits:${str(i, "op") || "match"}`, rationale: str(i, "op") === "receipt" ? `${str(i, "kind")} proceeds ${str(i, "amount_cents")}¢ received ${str(i, "received_on")} → instruct by ${String((out as { instruct_by?: string })?.instruct_by ?? "")}` : `${((out as { matched?: unknown[] })?.matched ?? []).length} debit(s) matched, ${((out as { unmatched_debits?: unknown[] })?.unmatched_debits ?? []).length} unmatched` }) };

const explainVariance: Omit<ToolDef, "process" | "agent"> = { name: "explainVariance", kind: "write", ruleSetVersion: RULE_SET_VERSION,
  handler: compute((i, ctx, rt) => {
    switch (str(i, "op") || "classify") {
      case "classify": return classifyOp(i, ctx, rt);
      case "schedule3": return schedule3Op(i, ctx, rt);
      case "resolve": return resolveOp(i, ctx, rt);
      default: throw new RangeError(`explainVariance op ${str(i, "op")} is not one of classify/schedule3/resolve`);
    }
  }),
  decision: (i, out) => { const o = out as { class?: string; variance_cents?: bigint; draft_expectation_cents?: bigint; kind?: string; unexplained_cents?: bigint } | null; return { action: `explainVariance:${str(i, "op") || "classify"}`, rationale: o?.class ? `expected ${str(i, "expected_cents")}¢, notified ${str(i, "notified_cents")}¢, variance ${String(o.variance_cents)}¢, classification=${o.class}, draft expectation ${String(o.draft_expectation_cents)}¢` : o?.kind ? `Schedule 3 ${str(i, "period")}: ${o.kind} ${String(o.unexplained_cents)}¢` : str(i, "explanation") || `explainVariance:${str(i, "op")}` }; } };

const postLedger: Omit<ToolDef, "process" | "agent"> = { name: "postLedger", kind: "write", ruleSetVersion: RULE_SET_VERSION, moneyFields: ["entry_set", "expected_draft_cents"],
  handler: compute((i, ctx, rt) => {
    if (fundOp(i)) return fundDraftOp(i, ctx, rt);
    const set = i.entry_set as EntrySetInput | undefined;
    if (!set) throw new RangeError("postLedger needs entry_set {effectiveDate, description, lines[]} or op=fund_draft");
    for (const l of set.lines) if (!l.ruleRef) throw new RangeError("every ledger line carries a ruleRef");
    return ctx.ledger.post(set, ctx.now);
  }),
  decision: (i, out) => ({ action: fundOp(i) ? "postLedger:fund_draft" : "postLedger", rationale: fundOp(i) ? `T−1 16:00 ET funding check ${str(i, "period")} ${str(i, "remittance_type")}/${str(i, "cycle") || "standard"} draft ${str(i, "draft_date")}: ${String((out as { status?: string })?.status ?? "")}, advance ${String((out as { amount_cents?: bigint })?.amount_cents ?? 0n)}¢` : str(i, "rationale") || str(i, "reason") || `ledger set posted (${str(i, "transfer_kind") || "no transfer"})` }),
  guardrails: [noTiForPi, advanceCommandsOnly, dualControl, noAdvanceOnStopAdvance, holdPiUntilRecoveryDraft] };

const recordDecision: Omit<ToolDef, "process" | "agent"> = { name: "recordDecision", kind: "write", handler: decision(), decision: (i) => ({ action: str(i, "action") || "recordDecision", rationale: str(i, "rationale") }) };

export const TOOLS_5_2: readonly ToolDef[] = defineTools("5.2", AGENT, [buildCrsBatch, openPortalTask, pullDraftNotifications, matchBankDebits, explainVariance, postLedger, recordDecision]);
