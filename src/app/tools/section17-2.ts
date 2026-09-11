/**
 * §17.2 tools — the spec's tool strings for process 17.2, verbatim, via
 * `defineTools("17.2", "<agent>", defs)` from ../tools.ts (see section13.ts). Spread by ./section17.ts.
 *
 * The `transfer` agent plans and releases the goodbye and short-year runs end-to-end. Guardrails
 * encode the spec's sentences: release requires the officer's authorization (a decision row the
 * officer wrote, or the officer calling), the transferee block verified, `SM_TOLLFREE_LIVE_GATE` and
 * the frozen list — all read from what the store, the Notice Registry and the event log already
 * hold, never from flags the caller asserts. An officer is never an input field: the (b)(2) exclusion
 * and the (b)(3)(ii) 30-day exception are officer decision rows on file (`writeDecision` by the
 * officer, naming the batch) or the officer calling; the content checklist reads the rendered notice
 * the Notice Registry holds; recipients come from the loan's parties of record; the run's loans are
 * 17.1's attested frozen list. Borrower-facing text comes only from the 17.2 notice family; no
 * outbound calls or texts are generated (TCPA — inbound only); a skip trace is a data order.
 */
import { defineTools, compute, never, needsRole, noticeOps, str, flag, PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { evaluateGate } from "../evaluators.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Actor } from "../../kernel/events/types.ts";
import { contentCheck, REQUIRED_CONTENT } from "../../domain/transfers/respa.ts";
import { noticeRecipients, noticeRunMailed, planNoticeRun as planRun, type NoticeParty, type NoticeRunStatus } from "../../domain/transfers/inbound.ts";
import { respaEffectiveDate } from "../../domain/transfers/respa.ts";
import type { TransferType } from "../../domain/transfers/batch.ts";
import { planGoodbyeRun, verifyTransfereeBlock, releaseTransferOutRun, contentPresentFromPayload, ingestMailReturns, skipTraceOrder, relyOnExceptionB3ii, goodbyeTiming, TRANSFER_OUT_TEMPLATES, type TransfereeBlock } from "../../domain/transfers/ops-17-2.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const AGENT = "transfer";
const ALLOWED: readonly string[] = TRANSFER_OUT_TEMPLATES;
/** The notices a goodbye / combined / corrective / short-year run mails — what `runContentChecklist` accepts. */
const RUN_TEMPLATES: readonly string[] = ["NTC_REGX_1024_33B_GOODBYE_MS2", "NTC_REGX_1024_33B_COMBINED_MS2", "NTC_REGX_1024_33B_CORRECTIVE", "NTC_REGX_1024_17I4_SHORT_YEAR_TRANSFEROR"];
const isOfficer = (a: Actor): boolean => a.kind === "human" && a.role === "officer";
const unchanged = (i: ToolInput): { payee: boolean; address: boolean; account: boolean; amount: boolean } => { const u = (i.unchanged as Record<string, unknown> | undefined) ?? {}; return { payee: u.payee === true, address: u.address === true, account: u.account === true, amount: u.amount === true }; };
const allUnchanged = (i: ToolInput): boolean => { const u = unchanged(i); return u.payee && u.address && u.account && u.amount; };
const forBatch = (ctx: CommandContext, type: string, batchId: string) => ctx.events.ofType(type).filter((e) => e.aggregate?.kind === "transfer_batch" && e.aggregate.id === batchId).at(-1);

/** The frozen list: the latest attested `transfer_batch_loan_list_versions` row 17.1 stored for the batch (the partner officer's Quick Exchange "Agree", `transfer.loan_list.attested`); null when no attested version is on file. */
function frozenList(rt: ToolRuntime, batchId: string): { version: number; loans: string[] } | null {
  const rows = rt.store.list("transfer_batch_loan_list_versions", (d) => d.batch_id === batchId && d.attested === true && Array.isArray(d.loans)).map((r) => ({ version: Number(r.data.version ?? 0), loans: (r.data.loans as unknown[]).map(String) }));
  return rows.sort((a, b) => b.version - a.version)[0] ?? null;
}
/** Release facts, read from the store and the event log — never from the caller: (a) the transferee block `verifyTransfereeBlock` stored, (b) `SM_TOLLFREE_LIVE_GATE` evaluated over the batch's `contact_center.ready` facts, (c) the frozen list (17.1's attested version on file). */
function batchFacts(rt: ToolRuntime, ctx: CommandContext, batchId: string): { transferee_block_verified: boolean; contact_center_ready: boolean; contact_center_reason: string | null; loan_list_frozen: boolean; frozen: { version: number; loans: string[] } | null } {
  const b = rt.store.get("transfer_batches", batchId)?.data ?? {};
  const ready = forBatch(ctx, "contact_center.ready", batchId);
  const gate = evaluateGate("1.3.tollFreeAndIvrDisclosureLive", (ready?.payload as Record<string, unknown> | undefined) ?? (b.contact_center as Record<string, unknown> | undefined) ?? {});
  const frozen = frozenList(rt, batchId);
  return { transferee_block_verified: b.transferee_block_verified === true, contact_center_ready: gate.open, contact_center_reason: gate.reason ?? null, loan_list_frozen: frozen !== null, frozen };
}
/**
 * An officer's decision on file: an `agent_decisions` row written by a human officer (`writeDecision`) that names the run or the batch and
 * carries the action asked for. Who wrote it is the store's `updatedBy`, never a caller field; a bare id string, an agent-written row, a
 * row naming another subject or another action authorizes nothing.
 */
function officerDecision(rt: ToolRuntime, id: string, names: { run_id?: string; batch_id?: string }, action: RegExp, what: string): { officer: Actor | null; why: string | null } {
  if (!id) return { officer: null, why: `no officer ${what} decision id` };
  const d = rt.store.get("agent_decisions", id); if (!d) return { officer: null, why: `officer ${what} decision ${id} is not on file` };
  const subject = d.data.subject as { kind?: unknown; id?: unknown } | undefined;
  if (!d.updatedBy.startsWith("human:") || d.data.approved_role !== "officer") return { officer: null, why: `decision ${id} was not written by an officer (${d.updatedBy})` };
  if (names.run_id && d.data.run_id !== names.run_id && subject?.id !== names.run_id) return { officer: null, why: `decision ${id} does not name run ${names.run_id}` };
  if (names.batch_id && d.data.batch_id !== names.batch_id && subject?.id !== names.batch_id) return { officer: null, why: `decision ${id} does not name batch ${names.batch_id}` };
  if (!action.test(String(d.data.action ?? ""))) return { officer: null, why: `decision ${id} is not a ${what} authorization (${String(d.data.action)})` };
  return { officer: { kind: "human", id: d.updatedBy.slice("human:".length), role: "officer" }, why: null };
}
/** The officer behind an act: the calling officer, else the officer who wrote the named decision row — never an actor object on the input. */
const officerFor = (rt: ToolRuntime, ctx: CommandContext, id: string, names: { run_id?: string; batch_id?: string }, action: RegExp, what: string): { officer: Actor | null; why: string | null } => (isOfficer(ctx.actor) ? { officer: ctx.actor, why: null } : officerDecision(rt, id, names, action, what));
const NONE = { officer: null, why: null } as const;

export const TOOLS_17_2: readonly ToolDef[] = defineTools("17.2", AGENT, [
  { name: "planNoticeRun", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "batch_id", "type", "transfer_date");
      const batchId = str(i, "batch_id"); const frozen = frozenList(rt, batchId);
      const exclusion = str(i, "type") === "master_change_sub_retained" && allUnchanged(i) ? officerFor(rt, ctx, str(i, "exclusion_decision_id"), { batch_id: batchId }, /exclu|b\)?\(?2\)?|1024\.33\(b\)\(2\)/i, "(b)(2) exclusion") : NONE;
      const exception = str(i, "exception_basis") ? officerFor(rt, ctx, str(i, "exception_decision_id"), { batch_id: batchId }, /exception|b3ii|1024\.33\(b\)\(3\)\(ii\)|for[_ -]?cause/i, "(b)(3)(ii) exception") : NONE;
      const r = planGoodbyeRun({ batch_id: batchId, type: str(i, "type") as TransferType, transfer_date: date(i, "transfer_date"), installments_due_on_1st: flag(i, "installments_due_on_1st"), notice_mode: str(i, "notice_mode") === "combined" ? "combined" : "separate", unchanged: unchanged(i), officer: exclusion.officer, exception_basis: (i.exception_basis as "termination_for_cause" | undefined) ?? null, exception_confirmed_by: exception.officer });
      let timers_cancelled: { code: string; timer_id: string; reason: "exception_b3ii" }[] = [];
      if (r.run) {
        const id = `run-${r.run.batch_id}-${r.run.kind}`; const loanIds = frozen?.loans ?? [];
        rt.store.put("transfer_notice_runs", id, { ...r.run, id, due_at: r.run.due, loan_ids: loanIds, loan_count: loanIds.length, frozen_list_version: frozen?.version ?? null }, ctx.actor, ctx.now);
        ctx.events.append({ type: "transfer_notice_run.planned", aggregate: { kind: "transfer_batch", id: r.run.batch_id }, actor: ctx.actor, payload: { run_id: id, kind: r.run.kind, template: r.run.template, due: r.run.due, scheduled_on: r.run.scheduled_on, respa_effective_date: r.run.respa_effective_date, loan_count: loanIds.length, frozen_list_version: frozen?.version ?? null } });
        if (r.run.timer === "REGX_1024_33B3_EXCEPTION_30") timers_cancelled = relyOnExceptionB3ii(ctx.timers, ctx.events, { batch_id: batchId, basis: "termination_for_cause", confirmed_by: exception.officer, decision_id: isOfficer(ctx.actor) ? null : str(i, "exception_decision_id") }, ctx.actor).cancelled;
      }
      if (r.exclusion_record) { rt.store.put("transfer_notice_exclusions", `excl-${r.exclusion_record.batch_id}`, { ...r.exclusion_record, decision_id: isOfficer(ctx.actor) ? null : str(i, "exclusion_decision_id") }, ctx.actor, ctx.now); ctx.events.append({ type: "transfer.notice.excluded", aggregate: { kind: "transfer_batch", id: r.exclusion_record.batch_id }, actor: ctx.actor, payload: { basis: r.exclusion_record.basis, approved_by: r.exclusion_record.approved_by, decision_id: isOfficer(ctx.actor) ? null : str(i, "exclusion_decision_id") } }); }
      if (r.block) rt.escalations.open({ kind: "officer", batchId, payload: { block: r.block, batch_id: batchId, type: str(i, "type"), officer_decision_problems: [exclusion.why, exception.why].filter((x): x is string => !!x) } }, ctx.actor);
      return { ...r, frozen_list: frozen ? { version: frozen.version, loan_count: frozen.loans.length } : null, timers_cancelled, officer_decision_problems: [exclusion.why, exception.why].filter((x): x is string => !!x) }; }),
    guardrails: [never("OFFICER_IS_NOT_AN_INPUT", "17.2 escalations: `officer` (Supermortgage) — an officer is the calling actor or a decision row the officer wrote (writeDecision), never a field the caller fills", (i) => i.officer !== undefined || i.exception_confirmed_by !== undefined, "name the officer's decision row (exclusion_decision_id / exception_decision_id): an actor object on the input authorizes nothing"),
      never("EXCEPTION_30_FNMA_DIRECTED_ONLY", "§1024.33(b)(3)(ii); 17.2 verified requirement: 'the only Section 17 case where this can apply is a fnma_directed for-cause termination'", (i) => !!str(i, "exception_basis") && (str(i, "type") !== "fnma_directed" || str(i, "exception_basis") !== "termination_for_cause"), "the 30-day post-effective notice applies only to a fnma_directed for-cause termination; every other transfer-out owes the goodbye ≥15 days before the effective date"),
      needsRole("EXCEPTION_30_NEEDS_OFFICER", "§1024.33(b)(3)(ii); 17.2 edge case: 'the platform requires officer confirmation that the basis is met before relying on it'", (i) => !!str(i, "exception_basis") && !str(i, "exception_decision_id"), ["officer"], "the 30-day post-effective notice may not be relied on without the officer's confirmation of the for-cause basis on file (exception_decision_id)"),
      needsRole("EXCLUSION_NEEDS_OFFICER", "§1024.33(b)(2); 17.2-T9 / 1.3-T10: 'the exclusion is an officer record, never silence'", (i) => str(i, "type") === "master_change_sub_retained" && allUnchanged(i) && !str(i, "exclusion_decision_id"), ["officer"], "a (b)(2) exclusion needs the officer's exclusion record on file (exclusion_decision_id); a subservicer change that moves the payee or payment address is never excluded")] },
  { name: "renderNotice", kind: "act", handler: noticeOps("render"),
    guardrails: [never("TEMPLATE_FAMILY_17_2", "17.2 outputs: goodbye/combined MS-2, corrective, short-year statement, misdirected-payment return — borrower-facing text only from the Notice Registry", (i) => !!str(i, "template_code") && !ALLOWED.includes(str(i, "template_code")), "template is not one of the 17.2 notices")] },
  /** The machine content check over the rendered notice the Notice Registry holds (`renderNotice`): the nine required items are read from the payload the renderer consumed and from the rendered text — nothing is taken from the caller. */
  { name: "runContentChecklist", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "notice_id");
      const svc = rt.notices; if (!svc) throw new PortUnavailable("notices");
      const n = svc.get(str(i, "notice_id"));
      if (!RUN_TEMPLATES.includes(n.templateCode)) throw new RangeError(`${n.templateCode} is not a 17.2 run notice (${RUN_TEMPLATES.join(", ")})`);
      const present = contentPresentFromPayload(n.payload, n.rendered.text);
      const c = contentCheck(present); const loanId = n.loanId ?? (str(i, "loan_id") || null);
      rt.store.put("transfer_notices", n.id, { notice_id: n.id, run_id: str(i, "run_id") || null, loan_id: loanId, template: n.templateCode, template_version: n.templateVersion, payload_hash: n.payloadHash, notice_status: n.status, registry_checklist_passed: n.checklist.passed, content_present: present, missing: c.missing, checklist_ok: c.ok && n.checklist.passed, checked_at: ctx.now, source: "notice_service" }, ctx.actor, ctx.now);
      return { ...c, notice_id: n.id, loan_id: loanId, template: n.templateCode, present, required: REQUIRED_CONTENT, registry_checklist_passed: n.checklist.passed, notice_status: n.status }; }),
    guardrails: [never("CONTENT_FROM_RENDERED_NOTICE_ONLY", "17.2 rule: 'Notice content (machine-checked before release)' — the markers are read from the rendered notice on file, never asserted", (i) => i.present !== undefined || i.payload !== undefined || i.rendered_text !== undefined, "pass notice_id only: content is read from the rendered notice the Notice Registry holds (renderNotice), not from present/payload/rendered_text on the input")] },
  /** Recipients from the loan's parties of record (`loan_parties`: borrowers, confirmed successors, ACP substitutes, bankruptcy counsel — the address file of 4.4/14.x), never from the caller. */
  { name: "validateAddress", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "notice_id", "loan_id");
      const loanId = str(i, "loan_id");
      const parties = rt.store.list("loan_parties", (d) => d.loan_id === loanId).map((r) => r.data as unknown as NoticeParty);
      if (parties.length === 0) throw new RangeError(`no parties of record for loan ${loanId} (address file: borrowers, confirmed successors, ACP substitutes, bankruptcy counsel)`);
      const r = noticeRecipients(parties);
      const address_valid = r.some((x) => x.via !== "counsel_copy" && !!x.address) && parties.filter((p) => p.role === "borrower").every((p) => r.some((x) => x.party_id === p.party_id && !!x.address));
      rt.store.put("transfer_notices", str(i, "notice_id"), { notice_id: str(i, "notice_id"), loan_id: loanId, address_valid, recipients: r, parties_of_record: parties.length, validated_at: ctx.now }, ctx.actor, ctx.now);
      return { notice_id: str(i, "notice_id"), loan_id: loanId, address_valid, recipients: r }; }),
    guardrails: [never("ADDRESS_OF_RECORD_ONLY", "17.2 recipients: 'each borrower at their own address of record; confirmed successors in interest; ACP substitute addresses; for borrowers in bankruptcy a copy to counsel of record' — from the system of record (4.4, 14.x)", (i) => i.parties !== undefined, "recipients are read from the loan's parties of record (loan_parties); parties on the input are refused")] },
  { name: "verifyTransfereeBlock", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "batch_id", "block");
      const r = verifyTransfereeBlock((i.block as TransfereeBlock | undefined) ?? {}, optDate(i, "respa_effective_date"));
      rt.store.put("transfer_batches", str(i, "batch_id"), { transferee_notice_block: i.block, transferee_block_verified: r.ok, transferee_block_missing: r.missing, transferee_block_checked_at: ctx.now }, ctx.actor, ctx.now);
      if (r.event) ctx.events.append({ type: r.event, aggregate: { kind: "transfer_batch", id: str(i, "batch_id") }, actor: ctx.actor, payload: { batch_id: str(i, "batch_id"), verified_at: ctx.now } });
      else rt.escalations.open({ kind: "sev2", batchId: str(i, "batch_id"), payload: { timer_code: "SM_XFER_OUT_TRANSFEREE_NOTICE_DATA_T20", missing: r.missing, action: "transfer agent chases the transferee/partner for the missing notice data; a missing toll-free number blocks release (§1024.33(b)(4)(ii))" } }, ctx.actor);
      return r; }) },
  /** Release: the run's notices are the latest checked notice per loan on the run (a re-render supersedes the earlier one); every loan on the frozen list needs one that passed the content check and the address check and is not held by the Notice Registry. */
  { name: "releaseToVendor", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "run_id");
      const runId = str(i, "run_id"); const run = rt.store.require("transfer_notice_runs", runId).data;
      const batchId = String(run.batch_id ?? ""); const facts = batchFacts(rt, ctx, batchId);
      const rows = rt.store.list("transfer_notices", (d) => d.run_id === runId).map((n) => ({ id: String(n.data.notice_id ?? n.id), loan_id: typeof n.data.loan_id === "string" ? n.data.loan_id : null, content_present: Array.isArray(n.data.content_present) ? (n.data.content_present as string[]) : [], address_valid: n.data.address_valid === true, held: n.data.notice_status === "held", checked_at: String(n.data.checked_at ?? "") }));
      const latest = new Map<string, (typeof rows)[number]>();
      for (const n of rows) { const k = n.loan_id ?? `notice:${n.id}`; const cur = latest.get(k); if (!cur || n.checked_at > cur.checked_at) latest.set(k, n); }
      const notices = [...latest.values()];
      const decision = isOfficer(ctx.actor) ? { officer: ctx.actor, why: null } : officerDecision(rt, str(i, "officer_approval_decision_id"), { run_id: runId }, /release/i, "release");
      const r = releaseTransferOutRun({ run_id: runId, status: String(run.status ?? "planned") as NoticeRunStatus, kind: (String(run.kind ?? "goodbye")) as "goodbye", notices: notices.map(({ held: _h, checked_at: _c, ...n }) => n), transferee_block_verified: facts.transferee_block_verified, contact_center_ready: facts.contact_center_ready, loan_list_frozen: facts.loan_list_frozen, frozen_loan_ids: facts.frozen?.loans ?? null, officer_authorization: decision.officer });
      const refusals = [...r.refusals, ...notices.filter((n) => n.held).map((n) => `${n.id} is held by the Notice Registry checklist and cannot be mailed`), ...(decision.why ? [`release needs the Supermortgage officer's authorization: ${decision.why}`] : []), ...(facts.contact_center_reason && !facts.contact_center_ready ? [`SM_TOLLFREE_LIVE_GATE: ${facts.contact_center_reason}`] : [])];
      const out = { ...r, ok: refusals.length === 0, refusals, released_status: refusals.length === 0 ? r.released_status : null, facts: { transferee_block_verified: facts.transferee_block_verified, contact_center_ready: facts.contact_center_ready, loan_list_frozen: facts.loan_list_frozen, frozen_list_version: facts.frozen?.version ?? null, frozen_loan_count: facts.frozen?.loans.length ?? 0 } };
      if (out.ok) { rt.store.put("transfer_notice_runs", runId, { status: out.released_status, released_at: ctx.now, released_by: `${ctx.actor.kind}:${ctx.actor.id}`, officer_approval_decision_id: isOfficer(ctx.actor) ? null : str(i, "officer_approval_decision_id"), released_notice_count: notices.length, loan_ids: facts.frozen?.loans ?? [], loan_count: facts.frozen?.loans.length ?? 0, frozen_list_version: facts.frozen?.version ?? null }, ctx.actor, ctx.now); ctx.events.append({ type: "transfer_notice_run.released", aggregate: { kind: "transfer_notice_run", id: runId }, actor: ctx.actor, payload: { run_id: runId, batch_id: batchId, notice_count: notices.length, loan_count: facts.frozen?.loans.length ?? 0, frozen_list_version: facts.frozen?.version ?? null, officer_approval_decision_id: str(i, "officer_approval_decision_id") || null } }); }
      else rt.escalations.open({ kind: "officer", batchId, severity: r.escalation?.severity ?? "sev2", payload: { run_id: runId, reason: r.escalation?.reason ?? "release refused", refusals } }, ctx.actor);
      return out; }),
    guardrails: [needsRole("RELEASE_NEEDS_OFFICER", "17.2 state machine: release requires (d) officer (Supermortgage) authorization — no partner signature, the partner is copied", (i) => !str(i, "officer_approval_decision_id"), ["officer"], "release without the officer's approval decision on file (writeDecision by the officer naming the run)")] },
  { name: "ingestMailReturns", kind: "act", handler: compute((i, ctx, rt) => {
      // 32.12 backend delta (additive): `op=proofs` — the print vendor's proofs of mailing for a goodbye / combined / corrective run (1.3 outputs `notices.proof_of_mailing_document_id`): one `notice.mailed` per loan and, once every loan on the run has a proof, the run-level `notice.mailed{template, every_loan=true}` on the batch that satisfies REGX_1024_33B3_GOODBYE_15 / COMBINED_15 (inbound.ts noticeRunMailed, the same path 1.3 uses). The run is the stored `transfer_notice_runs` row when planNoticeRun recorded one, else planned here from the batch facts; the timing facts the borrower record renders (transferor stop, transferee start, window end, ACH cancel-by — ops-17-2 goodbyeTiming) are stored on the row.
      if (str(i, "op") === "proofs") {
        need(i, "batch_id", "proofs");
        const batchId = str(i, "batch_id"); const kind = (str(i, "kind") || "goodbye") as "goodbye" | "hello" | "combined" | "corrective"; const runId = str(i, "run_id") || `run-${batchId}-${kind}`;
        const stored = rt.store.get("transfer_notice_runs", runId)?.data ?? null;
        const transferDate = optDate(i, "transfer_date") ?? (stored?.transfer_date ? D(String(stored.transfer_date)) : null);
        const eff = optDate(i, "respa_effective_date") ?? (stored?.respa_effective_date ? D(String(stored.respa_effective_date)) : null) ?? (transferDate ? respaEffectiveDate(transferDate, i.installments_due_on_1st !== false) : null);
        if (!eff) throw new RangeError("respa_effective_date (or transfer_date) is required to plan the run the proofs belong to");
        const storedLoans = Array.isArray(stored?.loan_ids) ? (stored!.loan_ids as unknown[]).map(String) : [];
        const loanIds = storedLoans.length ? storedLoans : (Array.isArray(i.loan_ids) ? (i.loan_ids as unknown[]).map(String) : []);
        if (!loanIds.length) throw new RangeError("the run has no loans: name loan_ids (17.1's frozen list) or plan the run first");
        const run = planRun({ batch_id: batchId, respa_effective_date: eff, loan_ids: loanIds }, kind, runId);
        const priorProofs = (stored?.mailed_proofs as Record<string, { mailed_on: string; proof_of_mailing_id: string }> | undefined) ?? {};
        for (const [loanId, m] of Object.entries(priorProofs)) run.mailed.set(loanId, { mailed_on: D(m.mailed_on), proof_of_mailing_id: m.proof_of_mailing_id });
        if (Object.keys(priorProofs).length === loanIds.length && loanIds.length > 0) run.status = "mailed";
        const proofs = (i.proofs as { loan_id: string; proof_of_mailing_id: string; mailed_on: string }[]).map((p) => ({ loan_id: String(p.loan_id), proof_of_mailing_id: String(p.proof_of_mailing_id), mailed_on: D(String(p.mailed_on)) }));
        const r = noticeRunMailed(ctx.events, run, proofs, ctx.actor);
        const timing = transferDate ? goodbyeTiming(transferDate, i.installments_due_on_1st !== false) : null;
        const mailedProofs = Object.fromEntries([...run.mailed.entries()].map(([l, m]) => [l, { mailed_on: m.mailed_on, proof_of_mailing_id: m.proof_of_mailing_id }]));
        rt.store.put("transfer_notice_runs", runId, { ...(stored ?? { id: runId, batch_id: batchId, kind, template: run.template, due: run.due_at, due_at: run.due_at, loan_ids: loanIds, loan_count: loanIds.length, respa_effective_date: eff }), mailed_proofs: mailedProofs, mailed_count: r.mailed_count, status: r.every_loan ? "complete" : "released_to_vendor", ...(r.every_loan ? { mailed_on: proofs.map((p) => p.mailed_on).sort().at(-1) ?? null } : {}), ...(transferDate ? { transfer_date: transferDate } : {}), ...(timing ? { transferor_stops: timing.transferor_stops, transferee_starts: timing.transferee_starts, window_end: timing.window_end, ach_cancel_by: timing.ach_cancel_by, short_year_due: timing.short_year_due } : {}) }, ctx.actor, ctx.now);
        return { run_id: runId, batch_id: batchId, kind, template: run.template, due_at: run.due_at, mailed_count: r.mailed_count, every_loan: r.every_loan, run_event_id: r.run_event?.id ?? null, ...(timing ? { timing } : {}) };
      }
      need(i, "returns");
      const on = optDate(i, "returned_on") ?? D(ctx.now.slice(0, 10));
      const rows = ingestMailReturns((i.returns as { notice_id: string; loan_id: string; template: string; proof_of_mailing_id: string }[] | undefined) ?? [], on);
      for (const r of rows) { rt.store.put("mail_returns", `ret-${r.notice_id}`, { ...r, returned_on: on, status: "returned" }, ctx.actor, ctx.now); ctx.events.append({ type: r.event, loanId: r.loan_id, actor: ctx.actor, payload: { notice_id: r.notice_id, template: r.template, returned_at: on, skip_trace_due: r.skip_trace_due, original_proof_of_mailing_id: r.original_proof_of_mailing_id } }); }
      return rows; }) },
  { name: "orderSkipTrace", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "notice_id", "loan_id", "returned_on");
      const o = skipTraceOrder({ notice_id: str(i, "notice_id"), loan_id: str(i, "loan_id"), returned_on: date(i, "returned_on"), proof_of_mailing_id: str(i, "proof_of_mailing_id") });
      rt.store.put("skip_trace_orders", `st-${o.notice_id}`, { ...o, ordered_at: ctx.now, status: "ordered" }, ctx.actor, ctx.now);
      ctx.events.append({ type: "skiptrace.ordered", loanId: o.loan_id, actor: ctx.actor, payload: { notice_id: o.notice_id, due: o.due, original_proof_of_mailing_id: o.original_proof_of_mailing_id } });
      return o; }),
    guardrails: [never("INBOUND_ONLY", "17.2 AI agent design — TCPA: 'no outbound calls/texts are generated; inbound only'", (i) => flag(i, "outbound_call") || flag(i, "outbound_text"), "a skip trace is a data order (A2-7-03), never an outbound call or text")] },
  /** Decision record `{run_id or payment_id, loans, checklist_results, disposition, protected, rationale}` — queued for `agent_decisions` and kept in the store so `releaseToVendor` / `planNoticeRun` can verify an officer's authorization by its id (who wrote it is the store's `updatedBy`, never a caller field; a batch-level decision names the batch). */
  { name: "writeDecision", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "action", "rationale");
      const id = str(i, "id") || `dec-17.2-${rt.store.list("agent_decisions").length + 1}`;
      const subject = (i.subject as { kind: string; id: string } | undefined) ?? (str(i, "run_id") ? { kind: "transfer_notice_run", id: str(i, "run_id") } : str(i, "payment_id") ? { kind: "misdirected_payment", id: str(i, "payment_id") } : str(i, "batch_id") ? { kind: "transfer_batch", id: str(i, "batch_id") } : undefined);
      const row = { id, agent: str(i, "agent") || ctx.actor.id, action: str(i, "action"), rationale: str(i, "rationale"), run_id: str(i, "run_id") || null, payment_id: str(i, "payment_id") || null, batch_id: str(i, "batch_id") || null, loans: Array.isArray(i.loans) ? i.loans : [], checklist_results: i.checklist_results ?? null, disposition: str(i, "disposition") || null, protected: typeof i.protected === "boolean" ? i.protected : null, rule_code: str(i, "rule_code") || null, subject: subject ?? null, approved_by: ctx.actor.kind === "human" ? ctx.actor.id : null, approved_role: ctx.actor.kind === "human" ? (ctx.actor.role ?? null) : null, decided_at: ctx.now };
      rt.store.put("agent_decisions", id, row, ctx.actor, ctx.now);
      ctx.decide({ agent: row.agent, action: row.action, rationale: row.rationale, ruleSetVersion: str(i, "rule_set_version") || "17.2@tools.v1", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, ...(subject ? { subject } : {}), ...(row.rule_code ? { ruleCode: row.rule_code } : {}), ...(Array.isArray(i.evidence_document_ids) ? { evidenceDocumentIds: i.evidence_document_ids as string[] } : {}), ...(typeof i.confidence === "number" ? { confidence: i.confidence } : {}) });
      return { recorded: true, id }; }) },
]);
