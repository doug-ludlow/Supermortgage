/**
 * §15.2 tools — the spec's tool strings for process 15.2, verbatim, via `defineTools("15.2", "<agent>", defs)`
 * from ../tools.ts (see section13.ts). Spread by ./section15.ts.
 *
 * The registry (spec/registry/agents.json) carries four of the Agents paragraph's twelve tool names — the
 * extractor stopped at the slash in "`buildBulkPackage`/`submitClaimApi`" — so the process's lifecycle is
 * reached through `op` dispatch on those four (the "a.read/write" / "timer.*" house pattern):
 *   sweepClaimCandidates  op=candidates (nightly sweep, rule 1; milestone events → `claim.milestone.reached`)
 *                         op=status_poll (weekly `pollClaimStatus`: `p360.claim.status_refreshed` / `p360.claim.status_changed`,
 *                         PSA/Paid clocks, the PSA auto-denial past its 60-day countdown (sev-1), rule-10 denial triage → IRT tasks,
 *                         write-offs, the cumulative $5,000-per-loan officer briefing; IRT analyst responses → `p360.inquiry.response_received`)
 *                         op=reconcile (monthly `matchPayment`: bank ACH credits → `p360.payment.ach_matched`, unmatched →
 *                         sev-2 package to FannieMae_REO_Disbursements@fanniemae.com; report refunds/remittances → `remittance.special.settled{code}`)
 *                         op=recoveries (`scheduleRepayment`, rule 8: the reinstatement/payoff collection against the advances Fannie Mae reimbursed →
 *                         `advance_recoveries` FIFO by advance and `advance_recovery.repayment_scheduled` — arms FNMA_F105_RECOVERABLE_REPAY_60)
 *                         op=incentive_repayment (F-1-05: a cancelled modification/deferral not re-entered within 30 days →
 *                         `workout_incentive.repayment_scheduled` — arms FNMA_F105_INCENTIVE_REPAY_60)
 *                         op=credit (rule 7: a refund/credit received against the stored claim → `claim_credits` and
 *                         `expense_claim.credit.received{remit_code, fnma_reimbursed_premium}` — arms FNMA_F105_MI_REFUND_336_30 for a post-payment MI refund)
 *                         op=hometracker (the HomeTracker bid feed, 9.9: each inbound bid record is validated and appended as
 *                         `preservation.bid.submitted` — satisfies FNMA_PPM_OVER_ALLOWABLE_BID_15 — and, once decided, `preservation.bid.decided{outcome}`,
 *                         whose denied/modified outcomes arm FNMA_PPM_BID_RECONSIDER_7; the line's claimable amount follows the decision)
 *   validateLine          rule 2 allowable schedules, rule 4 cut-offs (the FNMA_F105_ESCROW_ADV_CUTOFF_14 evaluator), rule 1 recoverability (+ the T3 excess-fee request)
 *   assembleClaim         the decision record (`recordDecision`), rule-4 exclusions, the E-4.4-02 gate, `claim.final.preparing`, attorney escalation;
 *                         a preservation line over its PPM cap with no bid id fails and is the "over-allowable condition discovered" →
 *                         `preservation.condition.discovered{over_allowable=true}` (arms FNMA_PPM_OVER_ALLOWABLE_BID_15: HomeTracker bid within 15 days)
 *   buildBulkPackage      op=build (`buildBulkPackage`/`submitClaimApi`: ZIP + NPI screen; API accepted → `p360.claim.submitted`;
 *                         5xx → same-day `p360.claims.bulk_upload` task with the deadline; rule-6 claim-age check on the stored claim) — packages
 *                         only the decision assembleClaim stored (no caller-supplied claim reaches P360)
 *                         op=record_upload / psa_response / irt_inquiry / irt_response — the `fnma_portal_operator` records the
 *                         portal act (`p360.claim.submitted`, `p360.psa.responded`, `irt.inquiry.filed`, `irt.inquiry.responded{by=submitter}`)
 *                         op=bid_reconsideration — the reconsideration of a denied/modified HomeTracker bid, with evidence, within 7 days of the
 *                         decision (`preservation.bid.reconsideration_submitted` satisfies FNMA_PPM_BID_RECONSIDER_7; unreconsidered denials leave the line at the cap)
 * Guardrails encode the Agents paragraph: never submit a line without a paid invoice and allowable basis (assembleClaim screens the
 * lines; buildBulkPackage refuses any claim it did not assemble); never mark `non_recoverable` without a cited legal basis; never
 * re-submit a claim that would push the age past `final_due_at` (decided on the claim's own event history); never attach documents
 * with NPI; denials > $5,000 per loan (cumulative) or a systematic pattern → `officer` briefing; portal clicks are the operator's.
 * Toggle-off is the bus's AI-off state (18.1): the validator tools still run on the human path and the human calling
 * buildBulkPackage is the ops-console approval before upload.
 */
import { defineTools, compute, never, needsRole, guard, str, flag, cents, type ToolDef, type ToolInput } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { attachmentContainsSsn, type ClaimLine } from "../../domain/reo/claims.ts";
import { validateLine152, claimContext152, excessFeeApprovalRequest, sweepClaimCandidates, milestoneReached, assembleClaim, buildBulkPackage, submissionChannel, resubmissionCheck, projectStatusUpdate, psaAutoDenialSweep, triageDenial, denialBriefing, reconcileReport, irtReplyDue,
  recoveryRepaymentBatch, reimbursedAdvancesFromClaims, recoveryRepaymentEvent, incentiveRepayment, incentiveRepaymentEvent, creditReceivedEvent,
  overAllowableConditions, overAllowableDiscoveredEvent, ingestHomeTrackerBid, bidReconsideration, type HomeTrackerBidRecord, type IngestedBid,
  type AdvanceRow, type AssembleInput, type ClaimDecision, type ClaimContext152, type ClaimLine152, type ContextInput, type Attachment, type StatusUpdate, type DeniedLine, type PaidClaimRow, type BankCredit, type RemittanceLine, type Track, type RecoverySource, type ReimbursedAdvance, type CreditKind } from "../../domain/reo/ops-15-2.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const list = <T>(i: ToolInput, k: string): T[] => (Array.isArray(i[k]) ? (i[k] as T[]) : []);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const todayOf = (i: ToolInput, now: string): PlainDate => optDate(i, "today") ?? D(now.slice(0, 10));
const AGENT = "claims-reo";
const PORTAL_OPS: ReadonlySet<string> = new Set(["record_upload", "psa_response", "irt_inquiry", "irt_response"]);
const PAID_STATUSES: ReadonlySet<string> = new Set(["paid", "partially_paid", "closed"]);

/** The validation context: either a resolved ClaimContext152 or `{state, track, event_date, servicing_option, legal_date?, …}` resolved against the versioned schedule. */
const resolveContext = (raw: unknown): ClaimContext152 => {
  const c = rec(raw);
  if (typeof c.attorney_fee_exhibit_cents === "bigint") return c as unknown as ClaimContext152;
  if (!c.state || !c.event_date) throw new RangeError("context needs state, track and event_date (the exhibit is resolved from allowable_fee_schedules)");
  return claimContext152({ ...(c as unknown as ContextInput), state: String(c.state), track: (c.track as Track | undefined) ?? "non_judicial", event_date: D(String(c.event_date)), servicing_option: (c.servicing_option as ContextInput["servicing_option"] | undefined) ?? "special", legal_date: c.legal_date ? D(String(c.legal_date)) : null });
};
const unpaidOrUnsupported = (l: Partial<ClaimLine>): boolean => !l.paid_on || l.invoice !== true;
const noBasis = (l: Partial<ClaimLine152>): boolean => l.nonrecoverable_indicator === "non_recoverable" && !l.legal_basis;
const hasNpi = (atts: readonly Partial<Attachment>[]): boolean => atts.some((a) => typeof a.text === "string" && attachmentContainsSsn(a.text));
/**
 * Rule 6 as a guardrail: a build / upload record for a claim that was already submitted, dated past the `final_due_at` its assembly
 * recorded, is refused before anything runs — decided on the claim's own event history (`expense_claim.status_changed{final_due_at}`
 * from assembleClaim, `p360.claim.submitted`), so no caller flag is needed; the caller's explicit `resubmission`/`final_due_at`/`submit_on` facts refuse too.
 */
const pastFinalDue = (i: ToolInput, ctx: CommandContext): boolean => {
  const explicitDue = optDate(i, "final_due_at"), explicitOn = optDate(i, "submit_on");
  if (flag(i, "resubmission") && explicitDue !== null && explicitOn !== null && explicitOn > explicitDue) return true;
  const op = String(i.op ?? "build"); if (op !== "build" && op !== "record_upload") return false;
  const claimId = str(i, "claim_id"); if (!claimId) return false;
  const on = optDate(i, "submitted_on") ?? todayOf(i, ctx.now);
  const history = ctx.events.byLoan(ctx.loanId).filter((e) => (e.payload as Record<string, unknown>).claim_id === claimId);
  if (!history.some((e) => e.type === "p360.claim.submitted")) return false;
  const assembled = [...history].reverse().find((e) => e.type === "expense_claim.status_changed" && typeof (e.payload as Record<string, unknown>).final_due_at === "string");
  const due = assembled ? String((assembled.payload as Record<string, unknown>).final_due_at) : null;
  return due !== null && on > D(due);
};
const claimEvent = (d: { interim: boolean; milestone: string }, claimId: string, channel: string, submittedOn: PlainDate, p360ClaimId: string | null): Record<string, unknown> =>
  ({ claim_id: claimId, kind: d.interim ? "interim" : "final", interim: d.interim, milestone_kind: d.milestone, channel, submitted_on: submittedOn, submitted_at: submittedOn, p360_claim_id: p360ClaimId });
type DenialHistoryLine = { loan_id: string; amount_cents: Cents; reason: string; claim_id: string; advance_id: string; denied_on: PlainDate };

export const TOOLS_15_2: readonly ToolDef[] = defineTools("15.2", AGENT, [
  // Schedules (Inputs): nightly candidate sweep (rule 1) | weekly status poll | monthly reconciliation-report match | rule 7/8 bookings.
  { name: "sweepClaimCandidates", kind: "write", handler: compute(async (i, ctx, rt) => {
      const op = String(i.op ?? "candidates");
      const today = todayOf(i, ctx.now);
      if (op === "status_poll") {
        const updates: StatusUpdate[] = list<StatusUpdate>(i, "updates");
        const p360 = rt.ports.p360;
        if (!updates.length && p360) {
          for (const c of rt.store.list("expense_claims", (d) => ["submitted", "hold", "psa", "approved"].includes(String(d.status)) && typeof d.claim_number === "string")) {
            const s = await p360.claimStatus(String(c.data.claim_number));
            updates.push({ claim_id: c.id, p360_status: s.status === "in_review" ? "submitted" : s.status, at: today });
          }
        }
        const out: { claim_id: string; changed: boolean; triage: unknown[] }[] = []; const denied: DeniedLine[] = [];
        for (const u of updates) {
          const stored = rt.store.get("expense_claims", u.claim_id);
          const loanId = (stored?.data.loan_id as string | undefined) ?? (i.loan_id as string | undefined) ?? ctx.loanId;
          const p = projectStatusUpdate(rec(stored?.data), u);
          rt.store.put("expense_claims", u.claim_id, p.patch, ctx.actor, ctx.now);
          for (const e of p.events) ctx.events.append({ type: e.type, loanId, aggregate: { kind: "expense_claims", id: u.claim_id }, actor: ctx.actor, payload: e.payload });
          const triage: unknown[] = [];
          for (const lo of u.line_outcomes ?? []) {
            if (lo.status === "approved") continue;
            const line: DeniedLine = { advance_id: lo.advance_id, loan_id: loanId, amount_cents: cents(rec(lo).amount_cents), reason: (lo.reason as DeniedLine["reason"] | undefined) ?? "over_allowable", denied_on: u.at };
            denied.push(line); const t = triageDenial(line); triage.push(t);
            if (t.irt) { const irtId = `irt-${u.claim_id}-${lo.advance_id}`; rt.store.put("irt_inquiries", irtId, { claim_id: u.claim_id, advance_id: lo.advance_id, category: t.irt.category, status: "draft", file_by: t.irt.file_by, evidence: t.irt.evidence, denial_reason: line.reason }, ctx.actor, ctx.now);
              rt.escalations.open({ kind: "human_portal_task", loanId, payload: { task: "irt.inquiry.create", inquiry_id: irtId, claim_id: u.claim_id, category: t.irt.category, file_by: t.irt.file_by, evidence: t.irt.evidence, reason: `rule 10: ${line.reason} is curable — IRT inquiry with evidence within 5 BD` } }, ctx.actor); }
            if (t.write_off) { ctx.events.append({ type: "expense_claim.line.written_off", loanId, aggregate: { kind: "expense_claims", id: u.claim_id }, actor: ctx.actor, payload: { advance_id: lo.advance_id, amount_cents: t.write_off.amount_cents, root_cause: t.write_off.root_cause, authority: t.write_off.authority, ledger_rule: "Dr partner_loss_expense / Cr advance account (15.2 outputs)" } });
              if (t.write_off.authority === "officer") rt.escalations.open({ kind: "officer", loanId, payload: { reason: `write-off ${t.write_off.amount_cents} above the agent's $500/line authority (open question 4)`, claim_id: u.claim_id, advance_id: lo.advance_id, root_cause: t.write_off.root_cause } }, ctx.actor); }
            // the loan's cumulative denial history (`expense_claim_denials`, one row per loan) — the $5,000 briefing is per loan across polls, not per call
            const prior = list<DenialHistoryLine>(rec(rt.store.get("expense_claim_denials", loanId)?.data), "lines");
            rt.store.put("expense_claim_denials", loanId, { loan_id: loanId, lines: [...prior, { loan_id: loanId, amount_cents: line.amount_cents, reason: line.reason, claim_id: u.claim_id, advance_id: lo.advance_id, denied_on: u.at }] }, ctx.actor, ctx.now);
          }
          out.push({ claim_id: u.claim_id, changed: p.changed, triage });
        }
        // 15.2-T6: a claim still in PSA past P360's 60-day countdown with no response recorded is auto-denied (sev-1); past the internal 10 → sev-2 nudge
        const auto: { claim_id: string; status: string }[] = [];
        const inPsa = rt.store.list("expense_claims", (d) => d.status === "psa" && typeof d.psa_at === "string" && !d.psa_responded_at && !updates.some((u) => u.claim_id === String(d.claim_id ?? "")));
        for (const s of psaAutoDenialSweep(inPsa.map((r) => ({ claim_id: r.id, psa_at: D(String(r.data.psa_at)) })), today)) {
          const row = rt.store.get("expense_claims", s.claim_id)!; const loanId = String(row.data.loan_id ?? ctx.loanId);
          if (s.outcome.auto_denied) {
            rt.store.put("expense_claims", s.claim_id, { status: "denied", p360_status: "denied", auto_denied: true, denied_at: today, denial_reason: "psa_no_response" }, ctx.actor, ctx.now);
            ctx.events.append({ type: "p360.claim.status_changed", loanId, aggregate: { kind: "expense_claims", id: s.claim_id }, actor: ctx.actor, payload: { claim_id: s.claim_id, status: "denied", p360_status: "denied", at: today, auto_denied: true, psa_at: row.data.psa_at, psa_due_at: s.outcome.response_due, reason: "Pending Submitter Action: no response by the 60-day countdown → auto-denial (P360 User Guide)" } });
            rt.escalations.open({ kind: "sev1", loanId, severity: "sev1", payload: { reason: `claim ${s.claim_id} auto-denied: PSA of ${row.data.psa_at} unanswered by ${s.outcome.response_due} (FNMA_P360_PSA_RESPONSE_60)`, claim_id: s.claim_id, psa_at: row.data.psa_at, psa_due_at: s.outcome.response_due, next: "IRT inquiry (Expense Denied) with the requested documentation; loss to partner if not reopened" } }, ctx.actor);
            auto.push({ claim_id: s.claim_id, status: "denied" });
          } else if (s.outcome.severity === "sev2" && !row.data.psa_internal_missed_at) {
            rt.store.put("expense_claims", s.claim_id, { psa_internal_missed_at: today }, ctx.actor, ctx.now);
            rt.escalations.open({ kind: "sev2", loanId, severity: "sev2", payload: { reason: `claim ${s.claim_id}: PSA response past the internal 10-day target (${s.outcome.internal_due}); P360 auto-denies on ${s.outcome.response_due}`, claim_id: s.claim_id } }, ctx.actor);
            auto.push({ claim_id: s.claim_id, status: "psa" });
          }
        }
        // the officer briefing on the cumulative per-loan history (newly over $5,000, or a newly systematic reason)
        const briefed: string[] = [];
        for (const loanId of [...new Set(denied.map((d) => d.loan_id))]) {
          const history = list<DenialHistoryLine>(rec(rt.store.get("expense_claim_denials", loanId)?.data), "lines");
          const mine = denied.filter((d) => d.loan_id === loanId).map((d) => ({ loan_id: d.loan_id, amount_cents: d.amount_cents, reason: d.reason }));
          const prior = history.slice(0, Math.max(0, history.length - mine.length));
          const b = denialBriefing(history, prior);
          if (b.officer_briefing) { briefed.push(loanId); rt.escalations.open({ kind: "officer", loanId, payload: { reason: "denials > $5,000 per loan (cumulative) or systematic denial pattern (15.2 guardrail)", loans: b.loans_over_threshold, newly_over_threshold: b.newly_over_threshold, systematic_reason: b.systematic_reason, per_loan: b.per_loan, denied_lines: history.length } }, ctx.actor); }
        }
        for (const r of list<{ inquiry_id: string; claim_id?: string; response_at: string }>(i, "irt_responses")) {
          const responseAt = D(r.response_at); const replyDue = irtReplyDue(responseAt);
          rt.store.put("irt_inquiries", r.inquiry_id, { fnma_response_at: responseAt, response_due_at: replyDue, status: "pending" }, ctx.actor, ctx.now);
          ctx.events.append({ type: "p360.inquiry.response_received", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, aggregate: { kind: "irt_inquiries", id: r.inquiry_id }, actor: ctx.actor, payload: { inquiry_id: r.inquiry_id, claim_id: r.claim_id ?? null, response_at: responseAt, reply_due: replyDue } });
        }
        return { op, polled: out, auto_denials: auto, officer_briefing: briefed.length > 0, officer_briefed_loans: briefed };
      }
      if (op === "reconcile") {
        const paid = list<PaidClaimRow>(i, "paid_claims").length ? list<PaidClaimRow>(i, "paid_claims") : rt.store.list("expense_claims", (d) => !!d.paid_at && !d.ach_matched_entry_id).map((r) => ({ claim_id: r.id, loan_id: String(r.data.loan_id), paid_at: D(String(r.data.paid_at)), paid_amount_cents: cents(r.data.paid_amount_cents), ach_matched_entry_id: null }));
        const r = reconcileReport({ paid_claims: paid, bank_credits: list<BankCredit>(i, "bank_credits"), remittances: list<RemittanceLine>(i, "remittances"), today });
        const loanOf = (claimId: string): string => paid.find((p) => p.claim_id === claimId)?.loan_id ?? ctx.loanId;
        for (const m of r.matched) rt.store.put("expense_claims", m.claim_id, { ach_matched_entry_id: m.entry_id, status: "paid" }, ctx.actor, ctx.now);
        for (const e of r.events) ctx.events.append({ type: e.type, loanId: (e.payload.loan_id as string | undefined) ?? ctx.loanId, actor: ctx.actor, payload: e.payload });
        for (const s of r.settled) if (s.code === "353" || s.code === "352" || s.code === "571") for (const row of rt.store.list("advance_recoveries", (d) => d.loan_id === s.loan_id && d.crs_code === s.code && !d.fnma_repaid_at)) rt.store.put("advance_recoveries", row.id, { fnma_repaid_at: s.settled_on }, ctx.actor, ctx.now);
        for (const u of r.unmatched) if (u.package) rt.escalations.open({ kind: "sev2", loanId: loanOf(u.claim_id), severity: "sev2", payload: { reason: `ACH for claim ${u.claim_id} not matched by ${u.escalate_after} (expected ${u.expected}; 3 fannie_et BD + 2 BD tolerance)`, package_to: u.package.to, contents: u.package.contents, claim_id: u.claim_id } }, ctx.actor);
        return { op, ...r };
      }
      if (op === "recoveries") {
        // rule 8 (`scheduleRepayment`; 15.2-T9): the collected portion of each advance Fannie Mae reimbursed, FIFO by advance → advance_recoveries + CRS 353/352 batch due completion + 60
        need(i, "completion_on", "collected_cents");
        const loanId = str(i, "loan_id") || ctx.loanId; const completionOn = D(str(i, "completion_on")); const source = (str(i, "source") || "borrower_reinstatement") as RecoverySource;
        const paidClaims = rt.store.list("expense_claims", (d) => d.loan_id === loanId && (!!d.paid_at || PAID_STATUSES.has(String(d.status)))).map((r) => ({ paid_at: r.data.paid_at ? D(String(r.data.paid_at)) : D(String(r.data.submitted_at ?? today)), lines: list<{ advance_id: string; amount: Cents }>(rec(r.data), "lines").map((l) => ({ advance_id: l.advance_id, amount: cents(rec(l).amount) })) }));
        const reimbursed = list<ReimbursedAdvance>(i, "reimbursed").length ? list<ReimbursedAdvance>(i, "reimbursed").map((r) => ({ advance_id: r.advance_id, reimbursed_cents: cents(rec(r).reimbursed_cents), reimbursed_on: D(String(r.reimbursed_on)) })) : reimbursedAdvancesFromClaims(paidClaims);
        if (!["borrower_reinstatement", "payoff", "repurchase"].includes(source)) throw new RangeError(`source must be borrower_reinstatement, payoff or repurchase (rule 8), not ${source}`);
        const batch = recoveryRepaymentBatch({ completion_on: completionOn, source, collected_cents: cents(i.collected_cents), reimbursed });
        const tableSource = source === "repurchase" ? "repurchase_price" : source;   // advance_recoveries.source (0017): the repurchase-price collection is `repurchase_price`
        for (const r of batch.recoveries) rt.store.put("advance_recoveries", `${r.advance_id}@${completionOn}`, { loan_id: loanId, advance_id: r.advance_id, source: tableSource, amount_cents: r.amount_cents, recovered_at: completionOn, fnma_repay_due_at: batch.fnma_repay_due_at, crs_code: batch.crs_code, fnma_repaid_at: null }, ctx.actor, ctx.now);
        const e = recoveryRepaymentEvent(loanId, { completion_on: completionOn, source }, batch);
        if (e) ctx.events.append({ type: e.type, loanId, actor: ctx.actor, payload: e.payload });
        return { op, ...batch, scheduled: e !== null, reimbursed_considered: reimbursed.length };
      }
      if (op === "incentive_repayment") {
        // F-1-05: a modification/deferral incentive is repaid (CRS 350) within 60 days of the cancellation when the workout is not re-entered within 30 days
        need(i, "cancellation_date", "incentive_cents");
        const loanId = str(i, "loan_id") || ctx.loanId; const cancellation = D(str(i, "cancellation_date"));
        const r = incentiveRepayment({ cancellation_date: cancellation, re_entered_on: optDate(i, "re_entered_on"), incentive_cents: cents(i.incentive_cents), today });
        const e = incentiveRepaymentEvent(loanId, { cancellation_date: cancellation, workout_id: (i.workout_id as string | undefined) ?? null }, r);
        if (e) { rt.store.put("advance_recoveries", `incentive@${loanId}@${cancellation}`, { loan_id: loanId, advance_id: `incentive@${str(i, "workout_id") || loanId}`, source: "fnma_reimbursement", amount_cents: r.amount_cents, recovered_at: cancellation, fnma_repay_due_at: r.fnma_repay_due_at, crs_code: r.crs_code, fnma_repaid_at: null }, ctx.actor, ctx.now); ctx.events.append({ type: e.type, loanId, actor: ctx.actor, payload: e.payload }); }
        return { op, ...r, scheduled: e !== null };
      }
      if (op === "credit") {
        // rule 7 (15.2-T10): a refund/credit against the stored claim — before payment a claim_credits netting, after payment a remittance (318 hazard / 336 MI within 30 days / 571 other)
        need(i, "claim_id", "kind", "amount_cents", "received_at");
        const claimId = str(i, "claim_id"); const stored = rt.store.get("expense_claims", claimId); if (!stored) throw new RangeError(`expense claim ${claimId} not found`);
        const loanId = String(stored.data.loan_id ?? ctx.loanId); const receivedAt = D(str(i, "received_at")); const kind = str(i, "kind") as CreditKind;
        const e = creditReceivedEvent(loanId, claimId, { kind, amount_cents: cents(i.amount_cents), received_at: receivedAt }, { paid_at: (stored.data.paid_at as PlainDate | string | null | undefined) ?? null, status: String(stored.data.status ?? ""), lines: list<{ code: string }>(rec(stored.data), "lines") });
        const creditId = str(i, "credit_id") || `credit-${claimId}-${kind}-${receivedAt}`;
        rt.store.put("claim_credits", creditId, { claim_id: claimId, loan_id: loanId, kind, amount_cents: cents(i.amount_cents), received_at: receivedAt, remit_code_if_post_claim: e.treatment.remit_code, remit_due: e.treatment.due, treatment: e.treatment.treatment, remitted_at: null }, ctx.actor, ctx.now);
        if (e.treatment.treatment === "claim_credit") { const credits = list<Record<string, unknown>>(rec(stored.data), "credits"); rt.store.put("expense_claims", claimId, { credits: [...credits, { kind, amount_cents: cents(i.amount_cents), received_at: receivedAt }] }, ctx.actor, ctx.now); }
        ctx.events.append({ type: e.type, loanId, aggregate: { kind: "expense_claims", id: claimId }, actor: ctx.actor, payload: e.payload });
        return { op, credit_id: creditId, ...e.treatment, fnma_reimbursed_premium: e.payload.fnma_reimbursed_premium };
      }
      if (op === "hometracker") {
        // the HomeTracker bid feed (9.9 — Inputs "HomeTracker bid decisions"): each record validated, stored as `hometracker_bids`, appended as the bid facts; the advance's claimable amount follows the decision
        const bids = list<HomeTrackerBidRecord>(i, "bids"); if (!bids.length) throw new RangeError("bids is required (HomeTracker bid feed records)");
        const ingested: IngestedBid[] = [];
        for (const raw of bids) {
          const r = rec(raw); const advance = rt.store.get("advances", String(r.advance_id ?? ""));
          if (!r.bid_id || !r.advance_id || !r.submitted_on) throw new RangeError(`HomeTracker bid record needs bid_id, advance_id and submitted_on (got ${JSON.stringify({ bid_id: r.bid_id ?? null, advance_id: r.advance_id ?? null, submitted_on: r.submitted_on ?? null })})`);
          const b = ingestHomeTrackerBid(str(i, "loan_id") || (advance?.data.loan_id as string | undefined) || ctx.loanId, { bid_id: String(r.bid_id ?? ""), advance_id: String(r.advance_id ?? ""), claim_id: (r.claim_id as string | undefined) ?? (advance?.data.claim_id as string | undefined) ?? null, item: (r.item as string | undefined) ?? (advance?.data.item as string | undefined) ?? null,
            bid_cents: cents(r.bid_cents), submitted_on: D(String(r.submitted_on ?? "")), decided_on: r.decided_on ? D(String(r.decided_on)) : null, outcome: (r.outcome as IngestedBid["outcome"] | undefined) ?? null, approved_cents: r.approved_cents === undefined || r.approved_cents === null ? null : cents(r.approved_cents), cap_cents: r.cap_cents === undefined || r.cap_cents === null ? (typeof advance?.data.cap_cents === "bigint" ? (advance.data.cap_cents as Cents) : null) : cents(r.cap_cents) });
          const loanId = String(b.events[0]!.payload.loan_id);
          rt.store.put("hometracker_bids", b.bid_id, { loan_id: loanId, bid_id: b.bid_id, advance_id: b.advance_id, claim_id: b.claim_id, item: b.item, bid_cents: b.bid_cents, submitted_on: b.submitted_on, decided_on: b.decided_on, outcome: b.outcome, approved_cents: b.approved_cents, reconsider_by: b.reconsider_by, claimable_cents: b.claimable_cents, reconsideration_submitted_on: null }, ctx.actor, ctx.now);
          rt.store.put("advances", b.advance_id, { hometracker_bid_id: b.bid_id, bid_outcome: b.outcome, claimable_cents: b.claimable_cents }, ctx.actor, ctx.now);
          for (const e of b.events) ctx.events.append({ type: e.type, loanId, aggregate: { kind: "hometracker_bids", id: b.bid_id }, actor: ctx.actor, payload: e.payload });
          ingested.push(b);
        }
        return { op, bids: ingested.map(({ events: _e, ...b }) => b) };
      }
      const rows = list<AdvanceRow>(i, "advances").length ? list<AdvanceRow>(i, "advances") : rt.store.list("advances", (d) => typeof d.kind === "string" && typeof d.amount_cents === "bigint" && (!str(i, "loan_id") || d.loan_id === str(i, "loan_id"))).map((r) => r.data as unknown as AdvanceRow);
      const r = sweepClaimCandidates(rows);
      if (rows.length) ctx.events.append({ type: "expense_claim.candidates.swept", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, actor: ctx.actor, payload: { candidates: r.candidates.length, skipped: r.skipped } });
      const milestones = list<{ event_type: string; loan_id: string; milestone_date: string; mi_insured?: boolean; legal_date?: string | null }>(i, "milestones").map((m) => milestoneReached({ event_type: m.event_type, loan_id: m.loan_id, milestone_date: D(m.milestone_date), mi_insured: m.mi_insured === true, legal_date: m.legal_date ? D(m.legal_date) : null })).filter((m) => m !== null);
      for (const m of milestones) ctx.events.append({ type: m.type, loanId: m.payload.loan_id, actor: ctx.actor, payload: m.payload });
      return { op, ...r, milestones: milestones.map((m) => m.payload) }; }) },
  // Rule 2 allowable checks / rule 4 cut-offs / rule 1 recoverability, one line at a time; over-exhibit attorney fees name the firm request (T3).
  { name: "validateLine", kind: "read", handler: compute((i) => { need(i, "line", "context"); const c = resolveContext(i.context); const line = i.line as ClaimLine152; const v = validateLine152(line, c); return { ...v, excess_fee_request: excessFeeApprovalRequest(line, v, c.state) }; }),
    guardrails: [never("NO_NONRECOVERABLE_WITHOUT_BASIS", "15.2 guardrail: never mark `non_recoverable` without a cited legal basis", (i) => noBasis(rec(i.line) as Partial<ClaimLine152>), "cite the jurisdiction_rules / contract basis in the comment (Reg X §1024.35(b)(5); E-5-05)")] },
  // Assembly into the decision record; rule-4 exclusions; the E-4.4-02 refund gate; the attorney request for excess-fee approval ids before submission.
  { name: "assembleClaim", kind: "write", moneyFields: ["credits"], handler: compute((i, ctx, rt) => {
      need(i, "loan_id", "claim_type", "milestone_kind", "milestone_date", "lines", "context");
      const deferral = rec(i.deferral);
      const input: AssembleInput = { loan_id: str(i, "loan_id"), claim_type: str(i, "claim_type") as AssembleInput["claim_type"], milestone_kind: str(i, "milestone_kind") as AssembleInput["milestone_kind"], milestone_date: D(str(i, "milestone_date")), mi_insured: flag(i, "mi_insured"), disposition_date: optDate(i, "disposition_date"),
        lines: list<AssembleInput["lines"][number]>(i, "lines"), credits: list<AssembleInput["credits"][number]>(i, "credits"), context: resolveContext(i.context), hazard_refund_expected: flag(i, "hazard_refund_expected"), refund_refusal_comment: (i.refund_refusal_comment as string | undefined) ?? null, interim: flag(i, "interim"),
        deferral: i.deferral ? { closed_on: deferral.closed_on ? D(String(deferral.closed_on)) : null, post_payoff: deferral.post_payoff === true, incentive_cents: deferral.incentive_cents === undefined || deferral.incentive_cents === null ? null : cents(deferral.incentive_cents) } : null };
      const d = assembleClaim(input);
      const id = str(i, "claim_id") || `claim-${d.loan_id}-${d.milestone}-${d.milestone_date}`;
      const stored = rt.store.put("expense_claims", id, { ...d, claim_number: str(i, "claim_number") || id }, ctx.actor, ctx.now);
      ctx.events.append({ type: "expense_claim.status_changed", loanId: d.loan_id, aggregate: { kind: "expense_claims", id: stored.id }, actor: ctx.actor, payload: { claim_id: stored.id, status: d.status, final_due_at: d.final_due_at, gross: d.gross, net: d.net, exceptions: d.exceptions, excluded: d.excluded.map((x) => x.advance_id) } });
      // rule 4 / rule 1: the excluded lines are recorded per advance (the tag lands on `advances.post_sale_nonreimbursable`; collected lines are advance_recoveries, no claim)
      for (const x of d.excluded) {
        ctx.events.append({ type: "expense_claim.line.excluded", loanId: d.loan_id, aggregate: { kind: "expense_claims", id: stored.id }, actor: ctx.actor, payload: { claim_id: stored.id, advance_id: x.advance_id, reason: x.reason, tag: x.tag, amount_cents: x.amount, messages: x.messages, legal_date: input.context.legal_date ?? input.context.event_date } });
        if (x.tag === "post_sale_nonreimbursable") rt.store.put("advances", x.advance_id, { post_sale_nonreimbursable: true, nonreimbursable_reason: x.tag, claim_id: stored.id }, ctx.actor, ctx.now);
      }
      if (!d.interim) ctx.events.append({ type: "claim.final.preparing", loanId: d.loan_id, aggregate: { kind: "expense_claims", id: stored.id }, actor: ctx.actor, payload: { claim_id: stored.id, hazard_refund_expected: flag(i, "hazard_refund_expected"), milestone_kind: d.milestone, milestone_date: d.milestone_date } });
      const escalations = d.escalations.map((e) => rt.escalations.open({ kind: e.kind, loanId: d.loan_id, payload: { reason: e.reason, cap_cents: e.cap_cents, invoice_cents: e.invoice_cents, portal: e.portal, claim_id: stored.id } }, ctx.actor).id);
      // 9.9 reused (timer table): a preservation line over its PPM cap with no bid id is the over-allowable condition discovered — the HomeTracker bid is due in 15 days (FNMA_PPM_OVER_ALLOWABLE_BID_15); discovered once per advance
      const today = todayOf(i, ctx.now);
      const overAllowable = overAllowableConditions(d, today).filter((c) => !rt.store.get("advances", c.advance_id)?.data.over_allowable_discovered_on);
      for (const c of overAllowable) {
        rt.store.put("advances", c.advance_id, { over_allowable_discovered_on: c.discovered_on, bid_due: c.bid_due, item: c.item, cap_cents: c.cap_cents, claim_id: stored.id }, ctx.actor, ctx.now);
        const e = overAllowableDiscoveredEvent(d.loan_id, stored.id, c);
        ctx.events.append({ type: e.type, loanId: d.loan_id, aggregate: { kind: "expense_claims", id: stored.id }, actor: ctx.actor, payload: e.payload });
      }
      return { claim_id: stored.id, ...d, escalation_ids: escalations, over_allowable: overAllowable }; }),
    decision: (i, output) => { const o = output as ClaimDecision & { claim_id: string }; return { action: "assembleClaim", subject: { kind: "expense_claims", id: o.claim_id }, ruleCode: "15.2 rules 1-4, 7", rationale: String(i.rationale ?? `claim ${o.claim_id} ${o.status}: ${o.lines.length} lines, ${o.excluded.length} excluded, gross ${o.gross}, net ${o.net}, final_due_at ${o.final_due_at ?? "null"}, exceptions ${o.exceptions.length}`) }; },
    guardrails: [never("NO_LINE_WITHOUT_PAID_INVOICE", "15.2 guardrail: never submit a line without a paid invoice and allowable basis", (i) => list<Partial<ClaimLine>>(i, "lines").some(unpaidOrUnsupported), "each line needs paid_on and the retained invoice (E-5-02; F-1-05)"),
      never("NO_NONRECOVERABLE_WITHOUT_BASIS", "15.2 guardrail: never mark `non_recoverable` without a cited legal basis", (i) => list<Partial<ClaimLine152>>(i, "lines").some(noBasis), "cite the jurisdiction_rules / contract basis on the line (Reg X §1024.35(b)(5); E-5-05)")] },
  // The portal package tool: build the ZIP (NPI screen, rule-6 age check, API-or-bulk channel) from the stored decision and record the operator's portal acts.
  { name: "buildBulkPackage", kind: "act", handler: compute(async (i, ctx, rt) => {
      need(i, "claim_id");
      const claimId = str(i, "claim_id"); const op = String(i.op ?? "build"); const today = todayOf(i, ctx.now);
      const stored = rt.store.get("expense_claims", claimId);
      // only the decision assembleClaim recorded is packaged — a caller-supplied claim never reaches P360 (guardrail NO_UNASSEMBLED_CLAIM refuses it first)
      const claim = stored?.data as unknown as ClaimDecision | undefined;
      if (!claim) throw new RangeError(`expense claim ${claimId} not found — assembleClaim records the decision buildBulkPackage packages`);
      const loanId = claim.loan_id ?? ctx.loanId; const agg = { kind: "expense_claims", id: claimId };
      const claimNumber = str(i, "claim_number") || (stored?.data.claim_number as string | undefined) || claimId;
      if (op === "record_upload") {
        const errors = list<Record<string, unknown>>(i, "errors");
        if (errors.length) { rt.store.put("expense_claims", claimId, { validation_messages: errors, status: "draft" }, ctx.actor, ctx.now); ctx.events.append({ type: "expense_claim.upload.rejected", loanId, aggregate: agg, actor: ctx.actor, payload: { claim_id: claimId, errors, note: "Error-tab export parsed into validation_messages; fix and re-upload the same day (claim age not yet started)" } }); return { op, submitted: false, errors }; }
        need(i, "p360_claim_id");
        const on = optDate(i, "submitted_on") ?? today; const age = resubmissionCheck(rec(stored?.data), on);
        if (!age.allowed) throw new RangeError(age.refusal ?? "re-submission refused");
        const resets = Number(stored?.data.age_reset_count ?? 0);   // the build op already counted this re-submission's reset
        rt.store.put("expense_claims", claimId, { status: "submitted", submitted_at: on, submission_channel: str(i, "channel") || "bulk_upload", p360_claim_id: str(i, "p360_claim_id"), p360_status: "submitted", age_reset_count: resets }, ctx.actor, ctx.now);
        const payload = claimEvent(claim, claimId, str(i, "channel") || "bulk_upload", on, str(i, "p360_claim_id"));
        ctx.events.append({ type: "p360.claim.submitted", loanId, aggregate: agg, actor: ctx.actor, payload });
        ctx.events.append({ type: "expense_claim.status_changed", loanId, aggregate: agg, actor: ctx.actor, payload: { claim_id: claimId, status: "submitted", submitted_at: on, channel: payload.channel } });
        return { op, submitted: true, submitted_on: on, age_reset_count: resets };
      }
      if (op === "psa_response") {
        const on = optDate(i, "responded_on") ?? today; const docs = list<Attachment>(i, "attachments").map((a) => a.name);
        rt.store.put("expense_claims", claimId, { status: "submitted", p360_status: "submitted", psa_responded_at: on }, ctx.actor, ctx.now);
        ctx.events.append({ type: "p360.psa.responded", loanId, aggregate: agg, actor: ctx.actor, payload: { claim_id: claimId, responded_on: on, documents: docs, note: "attachment/comment, not a re-submission (rule 6)" } });
        return { op, responded_on: on, documents: docs };
      }
      if (op === "irt_inquiry") {
        need(i, "inquiry_id"); const on = optDate(i, "filed_on") ?? today; const id = str(i, "inquiry_id");
        rt.store.put("irt_inquiries", id, { claim_id: claimId, category: str(i, "category") || "Expense Denied", submitted_at: on, status: "new", document_ids: list<string>(i, "document_ids") }, ctx.actor, ctx.now);
        rt.store.put("expense_claims", claimId, { status: "disputed" }, ctx.actor, ctx.now);
        ctx.events.append({ type: "irt.inquiry.filed", loanId, aggregate: { kind: "irt_inquiries", id }, actor: ctx.actor, payload: { inquiry_id: id, claim_id: claimId, category: str(i, "category") || "Expense Denied", filed_on: on } });
        return { op, inquiry_id: id, filed_on: on };
      }
      if (op === "bid_reconsideration") {
        // FNMA_PPM_BID_RECONSIDER_7 (9.9 reused): a denied/modified HomeTracker bid on one of this claim's lines is reconsidered with evidence within 7 days of the decision
        need(i, "bid_id", "evidence"); const bidId = str(i, "bid_id"); const on = optDate(i, "submitted_on") ?? today;
        const bid = rt.store.get("hometracker_bids", bidId); if (!bid) throw new RangeError(`HomeTracker bid ${bidId} not found — record the feed with sweepClaimCandidates op=hometracker first`);
        const r = bidReconsideration(loanId, { bid_id: bidId, advance_id: String(bid.data.advance_id), claim_id: (bid.data.claim_id as string | null | undefined) ?? claimId, outcome: (bid.data.outcome as IngestedBid["outcome"]) ?? null, decided_on: (bid.data.decided_on as PlainDate | null | undefined) ?? null, bid_cents: cents(bid.data.bid_cents), claimable_cents: cents(bid.data.claimable_cents) }, on, list<string>(i, "evidence"));
        rt.store.put("hometracker_bids", bidId, { reconsideration_submitted_on: on, reconsideration_late: r.late, claimable_cents: r.claimable_cents }, ctx.actor, ctx.now);
        rt.store.put("advances", String(bid.data.advance_id), { claimable_cents: r.claimable_cents, bid_reconsidered_on: on }, ctx.actor, ctx.now);
        ctx.events.append({ type: r.event.type, loanId, aggregate: { kind: "hometracker_bids", id: bidId }, actor: ctx.actor, payload: r.event.payload });
        return { op, bid_id: bidId, submitted_on: on, reconsider_by: r.reconsider_by, late: r.late, claimable_cents: r.claimable_cents };
      }
      if (op === "irt_response") {
        need(i, "inquiry_id"); const on = optDate(i, "responded_on") ?? today; const id = str(i, "inquiry_id");
        rt.store.put("irt_inquiries", id, { submitter_response_at: on, status: "in_progress" }, ctx.actor, ctx.now);
        ctx.events.append({ type: "irt.inquiry.responded", loanId, aggregate: { kind: "irt_inquiries", id }, actor: ctx.actor, payload: { inquiry_id: id, claim_id: claimId, by: "submitter", responded_on: on } });
        return { op, inquiry_id: id, responded_on: on };
      }
      // op=build — rule 6 on the stored claim: a re-submission past final_due_at is refused before any package is built (the guardrail decided it on the event history first).
      const age = resubmissionCheck(rec(stored?.data), today);
      if (!age.allowed) { ctx.events.append({ type: "expense_claim.resubmission.refused", loanId, aggregate: agg, actor: ctx.actor, payload: { claim_id: claimId, submit_on: today, final_due_at: claim.final_due_at, reason: age.refusal } }); throw new RangeError(age.refusal ?? "re-submission refused"); }
      const pkg = buildBulkPackage(claim, claimNumber, list<Attachment>(i, "attachments"));
      if (!pkg.ok) { ctx.events.append({ type: "expense_claim.package.blocked", loanId, aggregate: agg, actor: ctx.actor, payload: { claim_id: claimId, blocked_by: pkg.blocked_by, findings: pkg.findings } }); return { op, package: pkg, channel: null }; }
      rt.store.put("expense_claims", claimId, { status: "package_ready", attachments_manifest: pkg.manifest, claim_number: claimNumber, ...(age.resubmission ? { age_reset_count: age.age_reset_count } : {}) }, ctx.actor, ctx.now);
      ctx.events.append({ type: "expense_claim.status_changed", loanId, aggregate: agg, actor: ctx.actor, payload: { claim_id: claimId, status: "package_ready", manifest: pkg.manifest, resubmission: age.resubmission, age_reset_count: age.age_reset_count } });
      // channel: the Expense Claims API when credentialed and wired (idempotent by claim_number); its failure or absence is the 5xx path.
      let apiStatus: number | null = typeof i.api_status === "number" ? i.api_status : null; let p360ClaimId: string | null = null;
      const p360 = rt.ports.p360;
      if (apiStatus === null && flag(i, "api_credentialed") && p360) {
        try { const r = await p360.submitClaim(claimNumber, str(i, "fnma_loan_number") || loanId, pkg.xlsx_rows, ctx.now); apiStatus = 200; p360ClaimId = r.claimNumber; }
        catch (e) { apiStatus = 503; ctx.events.append({ type: "expense_claim.api.failed", loanId, aggregate: agg, actor: ctx.actor, payload: { claim_id: claimId, error: (e as Error).message, on: today } }); }
      }
      const channel = submissionChannel({ api_credentialed: flag(i, "api_credentialed"), api_status: apiStatus, bulk_available: i.bulk_available === undefined ? true : flag(i, "bulk_available"), today, final_due_at: claim.final_due_at, line_count: claim.lines.length });
      if (channel.channel === "api") {
        rt.store.put("expense_claims", claimId, { status: "submitted", submitted_at: today, submission_channel: "api", p360_claim_id: p360ClaimId, p360_status: "submitted", age_reset_count: age.age_reset_count }, ctx.actor, ctx.now);
        const payload = claimEvent(claim, claimId, "api", today, p360ClaimId);
        ctx.events.append({ type: "p360.claim.submitted", loanId, aggregate: agg, actor: ctx.actor, payload });
        ctx.events.append({ type: "expense_claim.status_changed", loanId, aggregate: agg, actor: ctx.actor, payload: { claim_id: claimId, status: "submitted", submitted_at: today, channel: "api" } });
      }
      const task = channel.portal_task ? rt.escalations.open({ kind: "human_portal_task", loanId, payload: { task: channel.portal_task.task, claim_id: claimId, claim_number: claimNumber, deadline: channel.portal_task.deadline_shown, opened_on: channel.portal_task.opened_on, reason: channel.reason, manifest: pkg.manifest, screenshots_required: channel.screenshots_required, irt_late_filing_dispute: channel.irt_late_filing_dispute } }, ctx.actor) : null;
      return { op, package: pkg, channel, portal_task_id: task?.id ?? null, age_reset_count: age.age_reset_count }; }),
    guardrails: [never("NO_UNASSEMBLED_CLAIM", "15.2 guardrail: never submit a line without a paid invoice and allowable basis — only the decision assembleClaim recorded (lines screened for paid_on, the retained invoice and an allowable basis) is packaged or sent to the Expense Claims API", (i) => i.claim !== undefined || i.lines !== undefined, "assemble the claim with assembleClaim; buildBulkPackage packages the stored decision by claim_id, never a caller-supplied claim"),
      never("NO_NPI_ATTACHMENTS", "15.2 guardrail: never attach documents with NPI (automated redaction check must pass)", (i) => hasNpi(list<Partial<Attachment>>(i, "attachments")), "redact SSNs/account numbers before packaging (Job Aid)"),
      guard("NO_RESUBMIT_PAST_FINAL_DUE", "15.2 guardrail: never re-submit a claim that would push the age past `final_due_at`", (i, ctx) => (pastFinalDue(i, ctx) ? "a re-submission resets the claim age to the new submission date, past final_due_at; file a PSA comment/attachment instead (rule 6)" : undefined)),
      never("PSA_IS_NOT_RESUBMISSION", "15.2 rule 6: a PSA response is an attachment/comment, not a re-submission", (i) => String(i.op ?? "") === "psa_response" && flag(i, "resubmit"), "answer the PSA with the requested documents; do not re-submit the claim"),
      needsRole("PORTAL_ACTS_ARE_HUMAN", "15.2 Agents: bulk upload, PSA, IRT and CRS are `fnma_portal_operator` acts", (i) => PORTAL_OPS.has(String(i.op ?? "")), ["fnma_portal_operator"], "the agent builds the package; the operator validates, uploads and records the portal outcome")] },
]);
