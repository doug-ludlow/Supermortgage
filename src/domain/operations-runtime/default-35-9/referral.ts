/**
 * §35.9 rule 3 — "Referral is proposed by the engine and decided by a person." `case.refer{op: propose}` runs 13.1's
 * `foreclosure.gates.evaluate` inside the command (never asserted), checks 13.4's completed review (outcome refer), 13.6's
 * retained firm for the state and the absence of a hold row, and writes `case.referral.proposed` (arming
 * SM_CASE_REFERRAL_DECISION_2BD) with a 35.8 proposal on `foreclosure_case.refer` for `officer`. `{op: decide, decision}` needs an
 * officer: `approve` re-runs the gates — closed again → `case.referral.decided{decision: cancelled, cause: gate_closed}` and
 * nothing is sent; open → 13.6's matter referral (`attorney.message.send{kind: refer}`, the retained-firm gate) and 13.3's
 * package (`op: fc.send_referral` — `attorney_referrals.package_manifest`, `foreclosure.referral.sent`, FNMA_E3205_FIRM_ACK_2BD
 * armed) in the same transaction, then `firm.dispatch{kind: referral_package}`. A proposal is the latest `case.referral.proposed`
 * with no later `case.referral.decided` on the case (an event-sourced state, no table of its own).
 */
import type { CommandContext } from "../../../app/commands.ts";
import type { ToolInput, ToolRuntime } from "../../../app/tools.ts";
import { createHash } from "node:crypto";
import { ENGINE_ACTOR, EV, STEP_AGENTS } from "../default-35-9.ts";
import { foldInCommand, need, portsFor, q, s } from "./commands.ts";
import { delegate } from "./delegate.ts";
import { firmDispatch } from "./firm.ts";
import { onReferralSent } from "./expectations.ts";
import { caseFactsOf } from "./timeline.ts";
import { caseUuid, globalRows, loanRows, openForeclosure, str, type CurrentRow, type Row } from "./store.ts";
import { ioOf } from "./commands.ts";

interface Gates { open: boolean; blocked_by: string[]; gates: { gate_code: string; result: string }[]; counters?: { regx_days_delinquent?: number }; review_outcome?: string | null }
const fcCaseOf = async (ctx: CommandContext, rt: ToolRuntime, loanId: string, caseRef: string): Promise<CurrentRow | null> => (caseRef ? rt.store.get("foreclosure_cases", caseRef) ?? null : null) ?? rt.store.list("foreclosure_cases", (d) => d["loan_id"] === loanId && !/^closed_/.test(String(d["status"] ?? "")))[0] ?? openForeclosure(await loanRows(q(ctx), "foreclosure_cases", loanId));
const completedReview = (rt: ToolRuntime, loanId: string): CurrentRow | null => rt.store.list("prereferral_reviews", (d) => d["loan_id"] === loanId && Boolean(d["completed_at"])).at(-1) ?? null;
const openHold = (rt: ToolRuntime, loanId: string): CurrentRow | null => rt.store.list("foreclosure_holds", (d) => d["loan_id"] === loanId && d["status"] !== "released" && d["status"] !== "closed" && (d["closed_at"] === undefined || d["closed_at"] === null))[0] ?? null;
/** 13.6's retained firm for a state: an `attorney_retentions` row in force whose firm is `retained`. */
export async function retainedFirmFor(ctx: CommandContext, rt: ToolRuntime, state: string): Promise<string | null> {
  const st = state.toUpperCase();
  const retentions = [...rt.store.list("attorney_retentions", (d) => String(d["jurisdiction_state"] ?? "").toUpperCase() === st && Boolean(d["retained_from"]) && !d["retained_to"] && !d["suspended_from"]), ...(await globalRows(q(ctx), "attorney_retentions")).filter((r) => String(r.data["jurisdiction_state"] ?? "").toUpperCase() === st && Boolean(r.data["retained_from"]) && !r.data["retained_to"] && !r.data["suspended_from"])];
  for (const r of retentions) {
    const firmId = str(r.data, "firm_id");
    const firm = rt.store.get("attorney_firms", firmId) ?? (await globalRows(q(ctx), "attorney_firms")).find((f) => f.id === firmId) ?? null;
    if (firm && str(firm.data, "status") === "retained") return firmId;
  }
  return null;
}
/** The open proposal: the latest `case.referral.proposed` on the case with no later `case.referral.decided`. */
export async function openProposal(ctx: CommandContext, caseRef: string): Promise<{ event_id: string; payload: Row; sequence: string } | null> {
  const rows = await q(ctx).query<{ id: string; type: string; payload: Row; sequence: string }>(`SELECT id::text AS id, type, payload, sequence::text AS sequence FROM loan_events WHERE type IN ($1, $2) AND payload->>'case_id' = $3 ORDER BY sequence DESC LIMIT 1`, [EV.referralProposed, EV.referralDecided, caseRef]);
  const inMemory = ctx.events.all().filter((e) => (e.type === EV.referralProposed || e.type === EV.referralDecided) && String((e.payload as Row)["case_id"]) === caseRef).at(-1);
  const last = inMemory ? { id: inMemory.id, type: inMemory.type, payload: inMemory.payload as Row, sequence: "mem" } : rows[0];
  return last && last.type === EV.referralProposed ? { event_id: last.id, payload: last.payload, sequence: last.sequence } : null;
}

export async function caseRefer(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<Row> {
  const loanId = s(i, "loan_id") || ctx.loanId; need({ loan_id: loanId }, "loan_id");
  const op = s(i, "op") || "propose";
  const fc = await fcCaseOf(ctx, rt, loanId, s(i, "case_id"));
  if (!fc) throw new RangeError(`no open foreclosure case on ${loanId}`);
  const facts = caseFactsOf(loanId, caseUuid(fc.id), fc);
  const ports = portsFor(rt);
  if (op === "propose") {
    const existing = await openProposal(ctx, fc.id);
    if (existing) return { proposed: false, already: true, proposal_event_id: existing.event_id };
    if (str(fc.data, "status") !== "prereferral") return { proposed: false, reason: `case is ${str(fc.data, "status")}, not prereferral` };
    const g = (await delegate(rt, ctx, "13.1", "foreclosure.gates.evaluate", { loan_id: loanId, step: "refer" })).output as Gates;
    if (!g.open) return { proposed: false, reason: "gates closed", blocked_by: g.blocked_by };
    const review = completedReview(rt, loanId);
    if (!review || str(review.data, "outcome") !== "refer") return { proposed: false, reason: review ? `13.4 review outcome ${str(review.data, "outcome")}` : "no completed 13.4 review" };
    const firmId = s(i, "firm_id") || (await retainedFirmFor(ctx, rt, facts.state));
    if (!firmId) return { proposed: false, reason: `no retained firm for ${facts.state} (13.6)` };
    const hold = openHold(rt, loanId);
    if (hold) return { proposed: false, reason: `hold ${str(hold.data, "kind")} open` };
    const ev = ctx.events.append({ type: EV.referralProposed, loanId, actor: ctx.actor, payload: { loan_id: loanId, case_id: fc.id, case_uuid: facts.case_id, firm_id: firmId, gates: g.gates.filter((x) => x.result === "open").map((x) => x.gate_code), review_id: review.id, proposed_at: ctx.now, regx_day: g.counters?.regx_days_delinquent ?? null } });
    const workItemId = await ports.workItems.propose(q(ctx), { screen_code: "foreclosure_case", subject_kind: "loan", subject_id: loanId, loan_id: loanId, source_kind: "approval_pending", source_id: fc.id, required_role: "officer", now: ctx.now, due_at: null, action_code: "refer" });
    ctx.decide({ agent: STEP_AGENTS.foreclosure, action: "case.refer:propose", rationale: `gates open (${g.gates.length} evaluated), 13.4 review ${review.id} refer, retained firm ${firmId}, no hold → proposed for officer`, ruleSetVersion: "default-ops.v1", loanId, subject: { kind: "case", id: fc.id }, confidence: 1, modelVersion: "deterministic", promptVersion: "35.9-v1" });
    return { proposed: true, proposal_event_id: ev.id, firm_id: firmId, review_id: review.id, work_item_id: workItemId, gates: g.gates.length };
  }
  if (op === "decide") {
    need(i, "decision");
    const decision = s(i, "decision"); if (!["approve", "decline"].includes(decision)) throw new RangeError("decision must be approve | decline");
    const proposal = await openProposal(ctx, fc.id);
    if (!proposal) throw new RangeError(`no open referral proposal on case ${fc.id}`);
    const by = `${ctx.actor.kind}:${ctx.actor.id}`;
    if (decision === "decline") {
      ctx.events.append({ type: EV.referralDecided, loanId, actor: ctx.actor, payload: { loan_id: loanId, case_id: fc.id, decision: "decline", by, role: ctx.actor.role ?? null, reason: s(i, "reason") || null, proposal_event_id: proposal.event_id } });
      await ports.workItems.close(q(ctx), { source_kind: "approval_pending", source_id: `${fc.id}:refer`, disposition: "declined", now: ctx.now });
      return { decision: "decline", proposal_event_id: proposal.event_id };
    }
    // approve: the gates run again (never asserted); closed → cancelled, the person never approves a stale referral
    const g = (await delegate(rt, ctx, "13.1", "foreclosure.gates.evaluate", { loan_id: loanId, step: "refer", attempt_referral: true })).output as Gates;
    if (!g.open) {
      ctx.events.append({ type: EV.referralDecided, loanId, actor: ctx.actor, payload: { loan_id: loanId, case_id: fc.id, decision: "cancelled", cause: "gate_closed", blocked_by: g.blocked_by, by, role: ctx.actor.role ?? null, reason: s(i, "reason") || null, proposal_event_id: proposal.event_id } });
      await ports.workItems.close(q(ctx), { source_kind: "approval_pending", source_id: `${fc.id}:refer`, disposition: "cancelled:gate_closed", now: ctx.now });
      return { decision: "cancelled", cause: "gate_closed", blocked_by: g.blocked_by, proposal_event_id: proposal.event_id };
    }
    const firmId = String(proposal.payload["firm_id"] ?? "");
    // 13.6's matter referral (the retained-firm gate) then 13.3's package (the manifest, the referral event, the acknowledgment clock)
    await delegate(rt, ctx, "13.6", "attorney.message.send", { kind: "refer", loan_id: loanId, firm_id: firmId, matter_id: `matter-${fc.id}`, state: facts.state, case_id: fc.id, matter_kind: "foreclosure" });
    const docs = await packageDocuments(ctx, rt, fc);
    const day = Number(g.counters?.regx_days_delinquent ?? proposal.payload["regx_day"] ?? 121);
    const sent = await delegate(rt, ctx, "13.6", "attorney.message.send", { op: "fc.send_referral", loan_id: loanId, case_id: fc.id, firm_id: firmId, day, principal_residence: fc.data["principal_residence"] !== false, review_outcome: "refer", documents: docs });
    const referralEvent = sent.events.find((e) => e.type === "foreclosure.referral.sent") ?? { id: sent.event_id };
    const decided = ctx.events.append({ type: EV.referralDecided, loanId, actor: ctx.actor, payload: { loan_id: loanId, case_id: fc.id, decision: "approve", by, role: ctx.actor.role ?? null, reason: s(i, "reason") || null, referral_event_id: referralEvent.id, firm_id: firmId, proposal_event_id: proposal.event_id } });
    const dispatch = await firmDispatch({ loan_id: loanId, case_id: fc.id, firm_id: firmId, kind: "referral_package", owning_event_id: referralEvent.id, ...(str(fc.data, "referral_package_document_id") ? { document_id: str(fc.data, "referral_package_document_id") } : {}), payload: { referral_id: `ref-${fc.id}-${ctx.now.slice(0, 10)}`, documents: docs.map((d) => d.id), referral_sent_on: ctx.now.slice(0, 10) } }, ctx, rt);
    // the expectations the referral opens (rule 4) — the fold would write them post-commit; the same command writes them now
    const after = rt.store.get("foreclosure_cases", fc.id) ?? fc;
    await onReferralSent(ioOf(ctx, rt, ENGINE_ACTOR), caseFactsOf(loanId, facts.case_id, after), { sent_on: ctx.now.slice(0, 10) as never, ack_clock_ref: ctx.timers.byCode("FNMA_E3205_FIRM_ACK_2BD").find((t) => t.status === "armed")?.id ?? null });
    await ports.workItems.close(q(ctx), { source_kind: "approval_pending", source_id: `${fc.id}:refer`, disposition: "approved", now: ctx.now });
    await foldInCommand(ctx, rt, loanId, ctx.actor);
    return { decision: "approve", proposal_event_id: proposal.event_id, decided_event_id: decided.id, referral_event_id: referralEvent.id, firm_id: firmId, dispatch };
  }
  if (op === "send") throw new RangeError("op send is the approve decision's own step (rule 3: the same command runs 13.3's referral)");
  throw new RangeError("op must be propose | decide");
}

/** The package documents 13.3's manifest hashes: the case's referral package document (a `documents` row with its sha256) and the note custody image when on file. */
async function packageDocuments(ctx: CommandContext, rt: ToolRuntime, fc: CurrentRow): Promise<{ id: string; sha256: string }[]> {
  const out: { id: string; sha256: string }[] = [];
  const pkg = str(fc.data, "referral_package_document_id");
  if (pkg) { const d = /^[0-9a-f-]{36}$/i.test(pkg) ? (await q(ctx).query<{ sha256: string }>(`SELECT sha256 FROM documents WHERE id = $1::uuid`, [pkg]))[0] : undefined; out.push({ id: pkg, sha256: d?.sha256 ?? createHash("sha256").update(pkg).digest("hex") }); }
  for (const c of rt.store.list("note_custody", (d) => d["loan_id"] === fc.data["loan_id"])) { const img = str(c.data, "image_document_id") || str(c.data, "lost_note_affidavit_id"); if (img) out.push({ id: img, sha256: str(c.data, "image_sha256") || createHash("sha256").update(img).digest("hex") }); }
  if (!out.length) out.push({ id: `manifest-${fc.id}`, sha256: createHash("sha256").update(`manifest-${fc.id}`).digest("hex") });
  return out;
}

/** rule 2 step (d): propose when eligible with no open proposal; cancel an open proposal whose gates closed again. */
export async function referralStep(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): Promise<Row> {
  const loanId = s(i, "loan_id") || ctx.loanId;
  const fc = await fcCaseOf(ctx, rt, loanId, "");
  if (!fc) return { skipped: "no open foreclosure case" };
  const proposal = await openProposal(ctx, fc.id);
  if (proposal) {
    const g = (await delegate(rt, ctx, "13.1", "foreclosure.gates.evaluate", { loan_id: loanId, step: "refer" })).output as Gates;
    if (!g.open) {
      ctx.events.append({ type: EV.referralDecided, loanId, actor: ENGINE_ACTOR, payload: { loan_id: loanId, case_id: fc.id, decision: "cancelled", cause: "gate_closed", blocked_by: g.blocked_by, by: `agent:${ENGINE_ACTOR.id}`, proposal_event_id: proposal.event_id } });
      await portsFor(rt).workItems.close(q(ctx), { source_kind: "approval_pending", source_id: `${fc.id}:refer`, disposition: "cancelled:gate_closed", now: ctx.now });
      return { proposal: "cancelled", blocked_by: g.blocked_by };
    }
    return { proposal: "open", proposal_event_id: proposal.event_id };
  }
  if (str(fc.data, "status") !== "prereferral") return { skipped: `status ${str(fc.data, "status")}` };
  const review = completedReview(rt, loanId);
  if (!review || str(review.data, "outcome") !== "refer") return { skipped: review ? `review outcome ${str(review.data, "outcome")}` : "no completed 13.4 review" };
  return caseRefer({ loan_id: loanId, op: "propose", case_id: fc.id }, ctx, rt);
}
