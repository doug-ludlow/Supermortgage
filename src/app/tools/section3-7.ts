/**
 * §3.7 tools — tax/insurance disbursement (`escrow`). spec/registry/agents.json names exactly three tool strings for
 * 3.7 (`scheduleDisbursement`, `releaseDisbursement`, `postAdvance`; src/app/tools.test.ts refuses the rest), so the
 * AI-design paragraph's other verbs (`emitEscrowEvent`, `buildAttestationPackage`, `openHumanPortalTask`, `openCase`,
 * `investigateBill`) are `op`s of those three, defined with `defineTools("3.7", "escrow", defs)` and spread by
 * ./index.ts (the §3 section file ./section03.ts carries no 3.7 block). Every op appends the `loan_events` the 3.7
 * timer rows arm on and are satisfied by through src/domain/escrow/ops-3-7.ts:
 *
 *   scheduleDisbursement  bill (default: `escrow.bill.received` + `disbursement.scheduled`, rule 7 duplicate hash) | project (`escrow.line.created`)
 *                         | replan (`disbursement.scheduled{replanned=true}` after a reject, rule 8)
 *   releaseDisbursement   release (default: funds check → `escrow.disbursement.released{discount_captured}` + `disbursement.sent{lead_honored}`)
 *                         | confirm / reject / return / reissue (rule 8 rail status files: `disbursement.confirmed` / `.rejected` / `.returned`, reissue → `disbursement.sent`)
 *                         | post (rule 11: the ledger set → `ledger.entries.posted{account=escrow}` + `escrow.event.queued`) | ack | correct | reverse | period_close
 *                         | cutover (rule 12: `feature_flag.enabled` + Setup events) | setup_acks (`escrow.setup_events.accepted{pct}`)
 *                         | attestation_package (rule 13: BD3 package + `human_portal_task`) | attestation_submitted (human only) | notify (the 3.7 notices)
 *   postAdvance           advance (default: rule 6 ledger, `escrow.advance.posted`; waived loan → 3.8 revocation) | nonescrow_tax_delinquent (rules 9–10)
 *                         | resolve (`escrow.nonescrow.tax_delinquency.resolved{outcome}`) | hazard_inability ((k)(5)(ii)(A) evaluation for 9.2's LPI gate)
 *
 * Guardrails encode the paragraph's sentences: payee remittance changes need validated evidence and officer dual
 * approval > $10,000 / new payee; the agent may not skip a lien-protecting payment; the LPI gate is enforced by code;
 * the monthly attestation is a human UI act; sequences are the chain's, never the caller's.
 */
import { defineTools, compute, noticeOps, guard, never, humanWhen, str, num, flag, cents, type ToolDef, type ToolInput } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { requireDualControl } from "../roles.ts";
import type { TimerDef } from "../../kernel/timers/registry.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import { plainDate as D, addDays, addMonths, type PlainDate } from "../../kernel/calendar/date.ts";
import { businessDaysBetween, servicer } from "../../kernel/calendar/business.ts";
import type { Actor, DomainEvent } from "../../kernel/events/index.ts";
import { fundsCheck, hazardDecision, leadHonored, LEAD_DAYS, type Method } from "../../domain/escrow/disbursement.ts";
import { releaseApproval, advanceEntries, type CutoverLoan, type SetupAck } from "../../domain/escrow/ops.ts";
import { revocation } from "../../domain/escrow/waiver.ts";
import {
  receiveBill, projectLine, replanRejected, ingestRailStatus, reissueReturned, postEscrowActivity, ackEscrowEvent, correctEscrowEvent, reverseEscrowEvent, closeEscrowPeriod,
  enableEscrowEventReporting, recordSetupAcks, readyAttestationPackage, submitAttestation, flagNonEscrowDelinquency, resolveNonEscrowDelinquency, evaluateInabilityToDisburse,
  type BillRecord, type DisbursementKind, type RailStatus, type EscrowCategory, type AttestationCategory, type CancellationReason,
} from "../../domain/escrow/ops-3-7.ts";

// ---- shared helpers ----------------------------------------------------------------------------------------------
const today = (ctx: CommandContext): PlainDate => D(ctx.now.slice(0, 10));
const loanOf = (i: ToolInput, ctx: CommandContext): string => (typeof i.loan_id === "string" && i.loan_id ? i.loan_id : ctx.loanId);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const optCents = (v: unknown): bigint | null => (v === undefined || v === null || v === "" ? null : cents(v));
const optDate = (i: Record<string, unknown>, k: string): PlainDate | null => (typeof i[k] === "string" && i[k] ? D(String(i[k])) : null);
const p = (e: DomainEvent): Record<string, unknown> => e.payload as Record<string, unknown>;
const latest = <T>(xs: readonly T[]): T | undefined => xs[xs.length - 1];
/** Approvals arrive as actors (kind/id/role) recorded by the ops console; the handler never mints a role for them. */
const approvers = (i: ToolInput): Actor[] => ((i.approvals as unknown[] | undefined) ?? []).filter((a): a is Actor => !!a && typeof a === "object" && typeof (a as Actor).kind === "string" && typeof (a as Actor).id === "string");
/** Dual control (roles.ts): two distinct officers among the recorded approvers plus the executing actor. */
const dualControlHolds = (i: ToolInput, ctx: CommandContext, what: string): boolean => { try { requireDualControl([...approvers(i), ctx.actor], "officer", what); return true; } catch { return false; } };
/** The computation year that starts on `yearStart` ends the day before its anniversary. */
const yearEndFrom = (yearStart: PlainDate): PlainDate => addDays(addMonths(yearStart, 12), -1);
let registryCache: ReturnType<typeof loadOverriddenRegistry> | null = null;
/** A registry definition (with the §3 and 3.7 overrides) for a row a tool arms explicitly — a code the spec gives two triggers. */
const registryDef = (code: string): TimerDef => { registryCache ??= loadOverriddenRegistry(); const d = registryCache.get(code); if (!d) throw new RangeError(`no timer ${code}`); return d; };
const opOf = (i: ToolInput, dflt: string): string => str(i, "op") || dflt;

// ---- scheduleDisbursement ----------------------------------------------------------------------------------------
/** The inbound bill record as the feed delivers it (amounts arrive as bigint or decimal-cents strings). */
const billOf = (i: ToolInput, ctx: CommandContext): BillRecord => {
  const b = rec(i.bill);
  return { loan_id: typeof b.loan_id === "string" && b.loan_id ? b.loan_id : loanOf(i, ctx), bill_id: typeof b.bill_id === "string" ? b.bill_id : null, kind: String(b.kind ?? "tax") as DisbursementKind, payee: String(b.payee ?? ""), parcel_or_policy: String(b.parcel_or_policy ?? ""), period: String(b.period ?? ""),
    amount_cents: cents(b.amount_cents), due_on: String(b.due_on ?? "") as PlainDate, penalty_on: typeof b.penalty_on === "string" ? D(b.penalty_on) : null, received_on: String(b.received_on ?? ctx.now.slice(0, 10)) as PlainDate,
    discount: b.discount && typeof b.discount === "object" ? { pct: String(rec(b.discount).pct ?? "0"), by: String(rec(b.discount).by ?? "") as PlainDate } : null, feed: String(b.feed ?? ""), escrowed: b.escrowed === true, regx_days_delinquent: Number(b.regx_days_delinquent ?? NaN), state: typeof b.state === "string" ? b.state : null };
};
const SCHEDULE_USAGE = "scheduleDisbursement needs bill {kind, payee, parcel_or_policy, period, amount_cents, due_on, received_on, feed, escrowed, regx_days_delinquent, penalty_on?, discount?, state?} (op bill), line {line_type, projected_due_on, projected_amount_cents, source} (op project) or disbursement_id (op replan)";

// ---- releaseDisbursement -----------------------------------------------------------------------------------------
const RELEASE_OPS = ["release", "confirm", "reject", "return", "reissue", "post", "ack", "correct", "reverse", "period_close", "cutover", "setup_acks", "attestation_package", "attestation_submitted", "notify"] as const;
const RAIL_STATUS: Record<string, RailStatus> = { confirm: "confirmed", reject: "rejected", return: "returned" };
const NOTICES_3_7 = new Set(["NTC_IL_765_910_15_TAX_PAID", "NTC_SM_NONESCROW_TAX_DELINQUENCY", "NTC_SM_ESCROW_HAZARD_ADVANCE", "NTC_SM_ESCROW_ADVANCE"]);
const isRelease = (i: ToolInput): boolean => opOf(i, "release") === "release";
const categoriesOf = (v: unknown): AttestationCategory[] => (Array.isArray(v) ? v : []).map((c) => { const x = rec(c); const t = (o: Record<string, unknown>) => ({ loan_count: Number(o.loan_count ?? NaN), ending_balance_cents: cents(o.ending_balance_cents), aggregate_contractual_payment_cents: cents(o.aggregate_contractual_payment_cents) }); return { category: String(x.category ?? "") as EscrowCategory, ledger: t(rec(x.ledger)), fnma: t(rec(x.fnma)) }; });
const loansOf = (v: unknown): CutoverLoan[] => (Array.isArray(v) ? v : []).map((l) => { const x = rec(l); const fd = rec(x.first_deposit); return { loan_id: String(x.loan_id ?? ""), escrowed: x.escrowed === true, active: x.active !== false, categories: (Array.isArray(x.categories) ? x.categories : []).map((c) => ({ category: String(rec(c).category ?? ""), balance_cents: cents(rec(c).balance_cents) })), first_deposit: x.first_deposit ? { amount_cents: cents(fd.amount_cents), on: String(fd.on ?? "") as PlainDate } : null }; });
const acksOf = (v: unknown): SetupAck[] => (Array.isArray(v) ? v : []).map((a) => { const x = rec(a); return { loan_id: String(x.loan_id ?? ""), category: String(x.category ?? ""), status: String(x.status ?? "pending") as SetupAck["status"], ...(typeof x.accepted_on === "string" ? { accepted_on: D(x.accepted_on) } : {}) }; });

/** The rule-4 release: funds check, `escrow.disbursement.released{discount_captured}` (FNMA_B101_DISCOUNT_CAPTURE_WARN) and `disbursement.sent{lead_honored}` (the two penalty rows). */
const release = (i: ToolInput, ctx: CommandContext) => {
  const f = fundsCheck(cents(i.amount_cents), cents(i.escrow_balance_cents), cents(i.reserved_within_5bd_cents));
  const method = (i.method as Method | undefined) ?? "check"; const releaseOn = i.release_on ? D(str(i, "release_on")) : today(ctx); const mustPayBy = i.must_pay_by ? D(str(i, "must_pay_by")) : null;
  const lead_honored = mustPayBy ? leadHonored(releaseOn, mustPayBy, method) : null; const loan = loanOf(i, ctx);
  // FNMA_B101_DISCOUNT_CAPTURE_WARN is satisfied by a release with the discount captured (rule 2: funds available, no advance) — `discount_captured` is the scheduler's verdict passed through, false when the discount was lost.
  ctx.events.append({ type: "escrow.disbursement.released", loanId: loan, actor: ctx.actor, payload: { amount_cents: String(cents(i.amount_cents)), advance_cents: String(f.advance_cents), method, release_on: releaseOn, discount_captured: flag(i, "discount_captured"), disbursement_id: str(i, "disbursement_id") || null } });
  // REGX_1024_17K_DISBURSE_BEFORE_PENALTY_0 / FNMA_B101_DISBURSE_BEFORE_PENALTY_0: `disbursement.sent` with the method lead honored (lead_honored=true), then `confirmed` from the rail; a missed lead (false) or no must-pay date (null) satisfies neither.
  ctx.events.append({ type: "disbursement.sent", loanId: loan, actor: ctx.actor, payload: { disbursement_id: str(i, "disbursement_id") || null, kind: str(i, "kind") || "tax", method, amount_cents: String(cents(i.amount_cents)), release_on: releaseOn, must_pay_by: mustPayBy, lead_business_days: LEAD_DAYS[method], lead_honored } });
  return { ...f, method, lead_honored, entries: advanceEntries(cents(i.amount_cents), f.advance_cents) };
};
/** The 3.7 notices through the Notice Registry; the 765 ILCS 910/15 facts (payment date, amount, property identification) are read from the loan's own `disbursement.confirmed`, never from the caller. */
const notify = (i: ToolInput, ctx: CommandContext, rt: Parameters<ReturnType<typeof noticeOps>>[2]) => {
  const template = str(i, "template_code"); if (!NOTICES_3_7.has(template)) throw new RangeError(`releaseDisbursement op notify needs template_code ∈ {${[...NOTICES_3_7].join(", ")}}`);
  const loan = loanOf(i, ctx); const payload = { ...rec(i.payload) };
  if (template === "NTC_IL_765_910_15_TAX_PAID") {
    const c = latest(ctx.events.byLoan(loan).filter((e) => e.type === "disbursement.confirmed" && p(e).kind === "tax" && p(e).state === "IL"));
    if (!c) throw new RangeError(`no confirmed Illinois tax payment on loan ${loan}: the 765 ILCS 910/15 notice follows a disbursement.confirmed{kind=tax, state=IL}`);
    const paidOn = D(String(p(c).paid_on)); const sentOn = today(ctx);
    Object.assign(payload, { paid_on: paidOn, amount_cents: BigInt(String(p(c).amount_cents)), parcel: p(c).parcel, property_address: payload.property_address ?? p(c).property_address, business_days_after_payment: businessDaysBetween(paidOn, sentOn, servicer), disbursement_id: p(c).disbursement_id });
  }
  if (template === "NTC_SM_NONESCROW_TAX_DELINQUENCY") {
    const d = latest(ctx.events.byLoan(loan).filter((e) => e.type === "escrow.nonescrow.tax_delinquent"));
    if (!d) throw new RangeError(`no non-escrow tax delinquency flagged on loan ${loan} (postAdvance op nonescrow_tax_delinquent first)`);
    Object.assign(payload, { delinquent_cents: BigInt(String(p(d).delinquent_cents)), parcel: p(d).parcel, follow_up_on: p(d).follow_up_on, case_id: p(d).case_id });
  }
  return noticeOps("render_send")({ ...i, loan_id: loan, payload }, ctx, rt);
};

export const TOOLS_3_7: readonly ToolDef[] = defineTools("3.7", "escrow", [
  { name: "scheduleDisbursement", kind: "act", handler: compute((i, ctx) => {
      const op = str(i, "op") || (i.bill ? "bill" : i.line ? "project" : i.disbursement_id ? "replan" : "");
      if (op === "project") { const l = rec(i.line); return projectLine(ctx.events, { loan_id: loanOf(i, ctx), line_id: typeof l.line_id === "string" ? l.line_id : null, line_type: String(l.line_type ?? ""), projected_due_on: String(l.projected_due_on ?? "") as PlainDate, projected_amount_cents: cents(l.projected_amount_cents), source: String(l.source ?? "analysis"), actor: ctx.actor }); }
      if (op === "replan") return replanRejected(ctx.events, { loan_id: loanOf(i, ctx), disbursement_id: str(i, "disbursement_id"), replanned_on: i.replanned_on ? D(str(i, "replanned_on")) : today(ctx), ...(i.method ? { method: i.method as Method } : {}), actor: ctx.actor });
      if (op !== "bill") throw new RangeError(SCHEDULE_USAGE);
      return receiveBill(ctx.events, { bill: billOf(i, ctx), ...(i.method ? { method: i.method as Method } : {}), escrow_balance_cents: cents(i.escrow_balance_cents), other_due_within_30_cents: cents(i.other_due_within_30_cents), capture: i.capture !== false, actor: ctx.actor });
    }),
    decision: (i, out) => { const o = rec(out); const op = str(i, "op") || (i.bill ? "bill" : i.line ? "project" : "replan"); return { action: `disbursement.${op}`, rationale: str(i, "rationale") || (op === "bill" ? (o.blocked ? `duplicate bill blocked: ${String(o.anomaly)}` : `bill ${String(o.bill_id)} scheduled: release ${String(rec(o.schedule).release_on)}, discount ${rec(o.schedule).discount_captured ? "captured" : "not captured"}`) : op === "project" ? `projected installment, bill expected by ${String(o.expected_bill_by)}` : `re-planned ${str(i, "disbursement_id")} by ACH direct`), ruleCode: op === "bill" ? "3.7 rules 1–3, 7" : op === "replan" ? "3.7 rule 8" : "3.7 inputs" }; } },
  { name: "releaseDisbursement", kind: "act", handler: compute((i, ctx, rt) => {
      const op = opOf(i, "release"); if (!(RELEASE_OPS as readonly string[]).includes(op)) throw new RangeError(`releaseDisbursement needs op ∈ {${RELEASE_OPS.join(", ")}} (default release)`);
      const loan = loanOf(i, ctx); const processed = typeof i.processed_at === "string" ? { processed_at: i.processed_at } : {};
      switch (op) {
        case "release": return release(i, ctx);
        case "notify": return notify(i, ctx, rt);
        case "reissue": return reissueReturned(ctx.events, { loan_id: loan, disbursement_id: str(i, "disbursement_id"), reissued_on: i.reissued_on ? D(str(i, "reissued_on")) : today(ctx), ...(i.method ? { method: i.method as Method } : {}), check_no: str(i, "check_no") || null, actor: ctx.actor });
        case "confirm": case "reject": case "return": {
          const status = RAIL_STATUS[op]!;
          const r = ingestRailStatus(ctx.events, { loan_id: loan, disbursement_id: str(i, "disbursement_id"), status, on: (i.on ? D(str(i, "on")) : today(ctx)), external_ref: str(i, "external_ref"), reason: str(i, "reason") || null, amount_cents: optCents(i.amount_cents), parcel: str(i, "parcel") || null, property_address: str(i, "property_address") || null, actor: ctx.actor });
          // "`disbursement.rejected/returned` → re-plan within 2 BD": the registry trigger is the reject; a return arms the same code explicitly (one code, two triggers).
          if (status === "returned") ctx.timers.arm(registryDef("ESC_PAYEE_REJECT_REPLAN_2BD"), r.event);
          return { status, event_id: r.event.id, replan: r.replan, il_notice_due_on: r.il_notice_due_on, payload: r.event.payload };
        }
        case "post": return postEscrowActivity(ctx.events, ctx.ledger, { loan_id: loan, direction: str(i, "direction") as "deposit" | "disbursement", amount_cents: cents(i.amount_cents), item: str(i, "item") || str(i, "kind"), ...(i.category ? { category: i.category as EscrowCategory } : {}), ...processed, now: ctx.now,
          opening_balance_cents: optCents(i.opening_balance_cents), contractual_payment_cents: optCents(i.contractual_payment_cents), advance_cents: optCents(i.advance_cents), disbursement_id: str(i, "disbursement_id") || null, ...(i.custodial_account_id ? { custodial_account_id: str(i, "custodial_account_id") } : {}), actor: ctx.actor });
        case "ack": return ackEscrowEvent(ctx.events, { loan_id: loan, sequence: num(i, "sequence"), status: str(i, "status") as "accepted" | "accepted_warning" | "rejected", message: str(i, "message") || null, fnma_response_id: str(i, "fnma_response_id") || null, ...(typeof i.acked_at === "string" ? { acked_at: i.acked_at } : {}), now: ctx.now, actor: ctx.actor });
        case "correct": { const f = rec(i.fix); return correctEscrowEvent(ctx.events, { loan_id: loan, sequence: num(i, "sequence"), fix: { ...(f.amount_cents !== undefined ? { amount_cents: cents(f.amount_cents) } : {}), ...(f.balance_cents !== undefined ? { balance_cents: cents(f.balance_cents) } : {}) }, ...processed, now: ctx.now, actor: ctx.actor }); }
        case "reverse": return reverseEscrowEvent(ctx.events, ctx.ledger, { loan_id: loan, sequence: num(i, "sequence"), reason: str(i, "reason"), ...processed, now: ctx.now, ...(i.custodial_account_id ? { custodial_account_id: str(i, "custodial_account_id") } : {}), actor: ctx.actor });
        case "period_close": return closeEscrowPeriod(ctx.events, { servicer_number: str(i, "servicer_number"), period_key: str(i, "period_key"), ...(typeof i.closed_at === "string" ? { closed_at: i.closed_at } : {}), now: ctx.now, actor: ctx.actor });
        case "cutover": return enableEscrowEventReporting(ctx.events, { cutover_on: str(i, "cutover_on") as PlainDate, loans: loansOf(i.loans), ...(typeof i.enabled_at === "string" ? { enabled_at: i.enabled_at } : {}), now: ctx.now, actor: ctx.actor });
        case "setup_acks": return recordSetupAcks(ctx.events, { cutover_on: str(i, "cutover_on") as PlainDate, loans: loansOf(i.loans), acks: acksOf(i.acks), ...(typeof i.recorded_at === "string" ? { recorded_at: i.recorded_at } : {}), now: ctx.now, actor: ctx.actor });
        case "attestation_package": {
          const r = readyAttestationPackage(ctx.events, { servicer_number: str(i, "servicer_number"), period_key: str(i, "period_key"), categories: categoriesOf(i.categories), ...(typeof i.ready_at === "string" ? { ready_at: i.ready_at } : {}), now: ctx.now, actor: ctx.actor });
          // Attestation is UI-only: the fnma_portal_operator's work item carries the package; SLA BD2 of the following month.
          const task = rt.escalations.open({ kind: "human_portal_task", payload: { task: "escrow_attestation", period_key: str(i, "period_key"), servicer_number: str(i, "servicer_number"), package_ready_on: r.package_ready_on, sla_on: r.sla_on, variance: r.variance, variances: r.variances } }, ctx.actor);
          return { ...r, portal_task_id: task.id, owner_role: task.ownerRole };
        }
        default: return submitAttestation(ctx.events, { servicer_number: str(i, "servicer_number"), period_key: str(i, "period_key"), commentary: str(i, "commentary") || null, evidence_document_id: str(i, "evidence_document_id"), ...(typeof i.submitted_at === "string" ? { submitted_at: i.submitted_at } : {}), now: ctx.now, actor: ctx.actor });
      }
    }),
    decision: (i, out, ctx) => { const o = rec(out); const op = opOf(i, "release"); return { action: op === "release" ? "disbursement.released" : op === "notify" ? "notice.sent" : ["confirm", "reject", "return", "reissue"].includes(op) ? `disbursement.${String(o.status ?? "reissued")}` : `escrow.event.${op}`,
      rationale: str(i, "rationale") || (op === "release" ? `${str(i, "kind") || "tax"} ${String(i.amount_cents)} cents released by ${ctx.actor.kind}:${ctx.actor.id}${cents(rec(out).advance_cents) > 0n ? ` with a ${String(o.advance_cents)} cent advance` : ""}` : op === "attestation_submitted" ? `attestation ${String(o.outcome)}${o.variance_case_id ? ` (variance case ${String(o.variance_case_id)})` : ""}` : op === "post" ? `escrow event ${String(o.sequence)}: ${str(i, "item") || str(i, "kind")} ${str(i, "direction")} ${String(i.amount_cents)} cents, balance ${String(o.balance_cents)} cents` : `${op} ${str(i, "disbursement_id") || str(i, "period_key") || str(i, "template_code")}`.trim()),
      ruleCode: op === "release" ? "3.7 rule 4" : ["confirm", "reject", "return", "reissue"].includes(op) ? "3.7 rule 8" : op === "notify" ? "3.7 outputs" : "3.7 rule 11; LL-2026-05" }; },
    guardrails: [never("PAYEE_CHANGE_EVIDENCE", "3.7 guardrails: payee remittance changes require validated evidence", (i) => isRelease(i) && (flag(i, "new_payee") || !!i.payee_instruction_changed_on) && !i.payee_evidence_document_id, "a new payee or a changed remittance instruction needs validated evidence (payee_evidence_document_id)"),
      guard("PAYEE_CHANGE_DUAL", "3.7 guardrails: payee remittance changes need officer dual approval when > $10,000 or a new payee", (i, ctx) => (isRelease(i) && releaseApproval({ amount_cents: cents(i.amount_cents), payee_instruction_changed_on: i.payee_instruction_changed_on ? D(str(i, "payee_instruction_changed_on")) : null, release_on: i.release_on ? D(str(i, "release_on")) : today(ctx), new_payee: flag(i, "new_payee") }).dual_approval_required && !dualControlHolds(i, ctx, "payee change > $10,000 or a new payee") ? "officer dual approval missing: two distinct officer approvers are required for a payee change > $10,000 or a new payee" : undefined)),
      never("NEVER_SKIP_LIEN_PAYMENT", "3.7 guardrails: the agent may not skip a lien-protecting payment", (i) => isRelease(i) && (flag(i, "skip") || flag(i, "hold") || flag(i, "defer_for_funds") || (i.bill_amount_cents !== undefined && cents(i.amount_cents) < cents(i.bill_amount_cents))), "lien-protecting payments are never skipped, held or short-paid for lack of funds — advance the gap (§1024.17(k)(2); B-1-01)"),
      never("LPI_GATE", "3.7 guardrails: LPI gate enforced by code", (i) => isRelease(i) && i.kind === "hazard" && flag(i, "force_place_instead") && !hazardDecision(num(i, "regx_days_delinquent") || 0, typeof i.cancellation_reason === "string" ? i.cancellation_reason : null, flag(i, "vacant")).lpi_gate_open, "LPI gate closed: pay or advance the premium; force-placement needs a documented (k)(5)(ii)(A) inability (cancellation for a non-payment reason, or vacancy) on a borrower > 30 days overdue"),
      humanWhen("ATTESTATION_IS_HUMAN", "3.7 state machine: attestation → human_portal_task.open → attested_yes | attested_no_with_commentary (LL-2026-05 attestation is UI-only, fnma_portal_operator)", (i) => opOf(i, "release") === "attestation_submitted", "the monthly attestation is a human act in the Servicing Platform UI; the agent prepares the package (op attestation_package) and opens the portal task"),
      never("NO_OUT_OF_ORDER_RESEND", "3.7 edge cases: reject storms after a ledger correction — re-sequence and resubmit in order; never send out-of-order", (i) => opOf(i, "release") === "post" && i.sequence !== undefined, "the sequence is allocated by the loan's event chain (next per-loan integer), never supplied by the caller"),
      guard("NOTICE_FACTS_FROM_LOAN", "3.7 outputs: `NTC_IL_765_910_15_TAX_PAID` (765 ILCS 910/15: payment date, amount, property identification)", (i) => { const pl = rec(i.payload); return opOf(i, "release") === "notify" && str(i, "template_code") === "NTC_IL_765_910_15_TAX_PAID" && (pl.paid_on !== undefined || pl.amount_cents !== undefined) ? "the payment date and amount are read from the loan's disbursement.confirmed, not supplied by the caller" : undefined; })] },
  { name: "postAdvance", kind: "act", handler: compute((i, ctx) => {
      const op = opOf(i, "advance"); const loan = loanOf(i, ctx);
      if (op === "nonescrow_tax_delinquent") return flagNonEscrowDelinquency(ctx.events, { loan_id: loan, escrowed: flag(i, "escrowed"), parcel: str(i, "parcel"), delinquent_cents: cents(i.delinquent_cents), found_on: (i.found_on ? D(str(i, "found_on")) : today(ctx)), tax_sale_date: optDate(i, "tax_sale_date"), source: str(i, "source"), actor: ctx.actor });
      if (op === "resolve") return resolveNonEscrowDelinquency(ctx.events, { loan_id: loan, resolved_on: i.resolved_on ? D(str(i, "resolved_on")) : today(ctx), proof_of_payment_document_id: str(i, "proof_of_payment_document_id") || null, actor: ctx.actor });
      if (op === "hazard_inability") return evaluateInabilityToDisburse(ctx.events, { loan_id: loan, notice: str(i, "notice") as "insurance.policy.cancellation_notice" | "property.vacancy_confirmed", reason: str(i, "reason") as CancellationReason, received_on: (i.received_on ? D(str(i, "received_on")) : today(ctx)), regx_days_delinquent: num(i, "regx_days_delinquent"), actor: ctx.actor });
      if (op !== "advance") throw new RangeError("postAdvance needs op ∈ {advance (default), nonescrow_tax_delinquent, resolve, hazard_inability}");
      const entries = advanceEntries(cents(i.amount_cents), cents(i.advance_cents)); const on = i.advanced_on ? D(str(i, "advanced_on")) : today(ctx); const waived = flag(i, "waived");
      ctx.events.append({ type: "escrow.advance.posted", loanId: loan, actor: ctx.actor, payload: { advance_cents: String(cents(i.advance_cents)), cause: str(i, "cause") || "insufficient_funds", penalty_cause: str(i, "penalty_cause") || null, waived, advanced_on: on, item: str(i, "item") || "tax" } });
      let revoked: ReturnType<typeof revocation> | null = null;
      if (waived) {
        // 3.8 rule 5 / 3.7-T11: an advance for an unpaid item on a waived loan revokes the waiver the same day (FNMA_B101_WAIVER_REVOKE_ON_ADVANCE_0); the account is established with the advance + penalty as the opening deficiency and the (g)(2) initial statement is due in 45 days (REGX_1024_17G_INITIAL_STMT_45, 3.1 trigger `escrow.initial_statement.required`).
        revoked = revocation(on, cents(i.advance_cents), cents(i.penalty_cents));
        ctx.events.append({ type: "escrow.waiver.revoked", loanId: loan, actor: ctx.actor, payload: { revoked_on: revoked.revoked_on, reason: "advance_for_unpaid_item", item: str(i, "item") || "tax", advance_cents: String(cents(i.advance_cents)), penalty_cents: String(cents(i.penalty_cents)), deficiency_cents: String(revoked.deficiency_cents) } });
        ctx.events.append({ type: "escrow.account.established", loanId: loan, actor: ctx.actor, payload: { reason: "waiver_revoked", established_at: revoked.revoked_on, opening_balance_cents: String(revoked.opening_balance_cents), deficiency_cents: String(revoked.deficiency_cents), computation_year_start: revoked.revoked_on, next_computation_year_end: yearEndFrom(revoked.revoked_on), interim_analysis_required: true } });
        ctx.events.append({ type: "escrow.initial_statement.required", loanId: loan, actor: ctx.actor, payload: { reason: "post_settlement", established_at: revoked.revoked_on, due_on: revoked.initial_statement_due_on } });
      }
      return { entries, servicer_error_flag: str(i, "penalty_cause") === "agent_delay", advanced_on: on, revocation: revoked };
    }),
    decision: (i, out, ctx) => { const o = rec(out); const op = opOf(i, "advance"); return { action: op === "advance" ? "escrow.advance.posted" : `case.${op}`, rationale: str(i, "rationale") || (op === "advance" ? `${String(i.advance_cents)} cents advanced for ${str(i, "item") || "tax"} (${str(i, "cause") || "insufficient_funds"})${flag(i, "waived") ? "; waiver revoked (3.8 rule 5)" : ""} by ${ctx.actor.kind}:${ctx.actor.id}` : op === "resolve" ? `resolved: ${String(o.outcome)}` : op === "hazard_inability" ? `inability_to_disburse=${String(o.inability_to_disburse)} (${String(o.reason_code)})` : `non-escrow tax delinquency on parcel ${str(i, "parcel")}`), ruleCode: op === "advance" ? "3.7 rules 5–6; §1024.17(k)(2); B-1-01" : op === "hazard_inability" ? "§1024.17(k)(5)(ii)(A)" : "3.7 rules 9–10" }; } },
]);
