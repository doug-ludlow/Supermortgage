/**
 * Concrete commands on the bus — the tool surfaces the spec's agents call.
 * Each wraps a domain service with the process's role gates and guardrails
 * so the AI path and the ops console are held to the same rules; every one
 * registers itself with its owning agent's allowlist.
 */
import type { Actor } from "../kernel/events/index.ts";
import type { CommandSpec, Guardrail } from "./commands.ts";
import type { AgentRegistry } from "./agents.ts";
import { assertGate } from "./evaluators.ts";
import { BoardingService, type WaiverResult } from "../domain/boarding/service.ts";
import { CashieringService, type PostResult } from "../domain/cashiering/service.ts";
import { NoticeService, type Notice } from "../notices/service.ts";
import type { ChannelContext } from "../notices/channel.ts";

// ---- 1.1 boarding: waivers are a human act; money-field / hard-rule waivers need an officer.
export interface ProposeWaiverInput { readonly service: BoardingService; readonly batchLoanId: string; readonly ruleCode: string; readonly reason: string; readonly evidenceDocumentIds?: readonly string[]; readonly approver: Actor; }
export const boardingProposeWaiver: CommandSpec<ProposeWaiverInput, WaiverResult> = {
  name: "boarding.proposeWaiver", process: "1.1", agent: "boarding", ruleSetVersion: "1.1@3",
  allow: { agents: true, humansAny: true },
  guardrails: [{ code: "WAIVER_NEEDS_HUMAN", citation: "1.1 guardrails: every waiver needs a human", refuse: (i) => (i.approver.kind === "human" ? undefined : `approver ${i.approver.kind}:${i.approver.id} is not a human`) }],
  handler: (i) => {
    const r = i.service.proposeWaiver(i.batchLoanId, i.ruleCode, i.approver, i.reason, i.evidenceDocumentIds ?? []);
    if (!r.ok) throw new WaiverRefused(r.code, r.reason);
    return r;
  },
  decision: (i, _o, ctx) => ({ action: "waiver_proposed", ruleCode: i.ruleCode, subject: { kind: "batch_loan", id: i.batchLoanId }, rationale: i.reason, evidenceDocumentIds: i.evidenceDocumentIds ?? [], ...(ctx.run?.confidence !== undefined ? { confidence: ctx.run.confidence } : {}) }),
};
export class WaiverRefused extends Error { readonly code: string; constructor(code: string, reason: string) { super(`waiver refused [${code}]: ${reason}`); this.name = "WaiverRefused"; this.code = code; } }

// ---- 2.1 cashiering: post a payment; the agent cannot change received_on or post below the identification confidence.
export interface PostPaymentInput { readonly service: CashieringService; readonly paymentId: string; readonly loanId: string; readonly identificationConfidence: number; readonly borrowerConfirmed?: boolean; readonly changes?: Record<string, unknown>; readonly postingBacklogFacts?: Record<string, unknown>; }
const cashieringGuardrails: readonly Guardrail<PostPaymentInput>[] = [
  { code: "RECEIVED_ON_IMMUTABLE", citation: "2.1 guardrails: the agent cannot change received_on", refuse: (i, ctx) => (i.changes && "received_on" in i.changes && ctx.actor.kind === "agent" ? "received_on is set by receipt rules, never by the agent" : undefined) },
  { code: "IDENTIFICATION_CONFIDENCE", citation: "2.1 guardrails: no posting below 0.97 identification confidence without borrower confirmation", refuse: (i) => (i.identificationConfidence < 0.97 && !i.borrowerConfirmed ? `identification confidence ${i.identificationConfidence} < 0.97 and no borrower confirmation` : undefined) },
  { code: "POSTING_BACKLOG", citation: "2.1 SM_CASHIERING_POSTING_BACKLOG_GATE", refuse: (i) => { if (!i.postingBacklogFacts) return undefined; try { assertGate("2.1.noPostingBacklog", i.postingBacklogFacts); return undefined; } catch (e) { return (e as Error).message; } } },
];
export const cashieringPostPayment: CommandSpec<PostPaymentInput, PostResult> = {
  name: "cashiering.postPayment", process: "2.1", agent: "cashiering", ruleSetVersion: "2.1@1",
  allow: { agents: true, humanRoles: ["ops_analyst", "officer"] },
  moneyFields: ["amount_cents", "received_on", "credited_as_of", "upb_cents"],
  guardrails: cashieringGuardrails,
  handler: (i) => { i.service.identify(i.paymentId, i.loanId); return i.service.post(i.paymentId); },
  decision: (i, o) => ({ action: `payment.post:${o.plan.outcome}`, ruleCode: o.plan.allocations[0]?.rule_ref ?? "F-1-09", subject: { kind: "payment", id: i.paymentId }, rationale: `allocated ${o.plan.allocations.length} bucket(s); outcome ${o.plan.outcome}` }),
};

// ---- 7.1 disclosures: sendNotice — held notices cannot be sent; the checklist decided that, not the model.
export interface SendNoticeInput { readonly service: NoticeService; readonly noticeId: string; readonly channelContext?: ChannelContext; }
export const disclosuresSendNotice: CommandSpec<SendNoticeInput, Notice> = {
  name: "disclosures.sendNotice", process: "7.1", agent: "disclosures", ruleSetVersion: "regz.periodic_statement.2018",
  allow: { agents: true, humansAny: true },
  guardrails: [{ code: "NOTICE_HELD", citation: "7.1 guardrails: statements with any block rule failure cannot be sent", refuse: (i) => { const n = i.service.get(i.noticeId); return n.status === "held" ? `notice is held: ${n.heldReason}` : undefined; } }],
  handler: (i) => i.service.send(i.noticeId, i.channelContext ?? {}),
  decision: (i, o) => ({ action: "notice.send", subject: { kind: "notice", id: i.noticeId }, ruleCode: o.templateCode, rationale: `channels ${(o.channelDecision ?? []).map((d) => `${d.partyId}:${d.channel}`).join(", ")}` }),
};

// ---- 12.4 lossmit: a forbearance term is created only inside the gates (evaluator-backed).
export interface CreateForbearanceTermInput { readonly facts: Record<string, unknown>; readonly create: () => { termId: string; termEnd: string } }
export const lossmitCreateForbearanceTerm: CommandSpec<CreateForbearanceTermInput, { termId: string; termEnd: string }> = {
  name: "lossmit.createForbearanceTerm", process: "12.4", agent: "lossmit-underwriter", ruleSetVersion: "fnma.guide.2026-08-12",
  allow: { agents: true, humanRoles: ["lossmit_reviewer", "officer"] },
  guardrails: ["12.4.incrementMax3Months", "12.4.cumulativeMax12Months", "12.4.projectedDelinquencyMax12Months"].map((ref) => ({ code: ref, citation: "12.4 guardrails: cannot create a term breaching any gate", refuse: (i: CreateForbearanceTermInput) => { try { assertGate(ref, i.facts); return undefined; } catch (e) { return (e as Error).message; } } })),
  handler: (i) => i.create(),
  decision: (i, o) => ({ action: "forbearance.term.create", subject: { kind: "workout_plan_term", id: o.termId }, rationale: `term to ${o.termEnd}; gates passed on facts ${JSON.stringify(i.facts)}` }),
};

// ---- human-only acts (the agent prepares the package; a role executes)
export interface OfficerCertificationInput { readonly kind: "form_582" | "mora_response" | "reg_ab_assertion" | "form_200"; readonly packageDocumentId: string; }
export const officerCertify: CommandSpec<OfficerCertificationInput, { certified: true }> = {
  name: "qc-audit.officerCertify", process: "18.4", agent: "qc-audit", ruleSetVersion: "fnma.guide.2026-08-12",
  allow: { agents: false, humanRoles: ["officer"] },
  handler: () => ({ certified: true }),
  decision: (i) => ({ action: `certify:${i.kind}`, evidenceDocumentIds: [i.packageDocumentId], rationale: "officer certification (baseline §8 item 3)" }),
};

export const ALL_COMMANDS: readonly CommandSpec<never, unknown>[] = [boardingProposeWaiver, cashieringPostPayment, disclosuresSendNotice, lossmitCreateForbearanceTerm, officerCertify] as unknown as readonly CommandSpec<never, unknown>[];

export function registerCommands(agents: AgentRegistry): void {
  for (const c of ALL_COMMANDS) agents.registerTool(c.agent, c.name);
}
