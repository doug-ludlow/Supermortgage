/**
 * §17.3 tools — the spec's tool strings for process 17.3, verbatim, via
 * `defineTools("17.3", "transfer", defs)` from ../tools.ts (see section13.ts). Spread by ./section17.ts.
 *
 * agents.json lists thirteen tool strings for 17.3 (the `transfer` agent's) and src/app/tools.test.ts
 * holds every 17.3 tool to that list, so the acts the Agents paragraph gives the `custodial-recon`
 * agent (freezeLedgers, computeWires, matchWires, buildFinalAccounting, reconcileShortageSurplus,
 * postSettlement) and the `security-records` agent (custodian shipment, archive manifests,
 * de-identification) run as `op`s of the tie-out, acknowledgment, request and de-brief tools below —
 * the same bus, the same guardrails. Event vocabulary (what timers-17-3.ts keys on):
 *
 *   planDeliverables            transfer.deliverables.planned{direction=out, transfer_date, loan_count, fc_or_litigation, bk, emortgage_count, participation_pool, mi_insurers}
 *                               (the loan-list facts the approval event lacks — SM_XFER_OUT_LAW_FIRM_NOTICE_T1 / BK_TRUSTEE_NOTICE_T1 key on them; arms
 *                               FNMA_F1_11_ENOTE_SERVICING_AGENT_T0 on the batch when the list carries eNotes);
 *                               op=cutover → transfer.participation_notes.pending{participation_pool} (FNMA_F1_11_PARTICIPATION_NOTES_30) + one
 *                               transfer.mi_transfer_notice.pending{mi} per MI insurer (MI_MGIC_TRANSFER_NOTICE_60 on the MGIC one)
 *   generateDeliverable         transfer.deliverable.generated (corrected=true regenerates an acked deliverable: correction_seq + 1); kind=D32 builds the
 *                               daily forwarding file from the misdirected_payments{direction=out} rows and marks them forwarded
 *   runOutboundDqGate           transfer.deliverable.validated / transfer.dq_gate.failed / transfer.deliverable.attested;
 *                               op=freeze → transfer.cutover.frozen (payment_holds{transfer_out_cutover}); op=receipt → the SM_XFER_OUT_POST_T_EVENT_GATE refusal:
 *                               a receipt dated ≥ T on a listed loan is a misdirected_payments{direction=out} row + transfer.misdirected_payment.recorded, never payment.received;
 *                               op=match_wires → recon.transfer_out_wires.matched | .variance (+ the T&I / P&I wire entry sets on the ledger when the account ids are given);
 *                               op=shortage_surplus → fnma.shortage_surplus_adjustment.requested | recon.final_period.no_adjustment + recon.shortage_surplus.resolved{outcome};
 *                               op=custodial_window → transfer.custodial_recon.acked{adjustment_window_closed, open_variance, recon_acked_on};
 *                               op=custodial_disposition → transfer.custodial_account.disposed{outcome}; op=final_draft_cleared → transfer.final_remittance.cleared;
 *                               op=settlement → ledger.posted{advance_reimbursement_in} + transfer.advances.reimbursed
 *   sendDeliverable             transfer.deliverable.delivered (+ transfer.final_accounting.delivered for D31)
 *   ingestTransfereeAck         deliverable.acked{<kind>} + transfer.deliverable.acked | transfer.deliverable.exception (op=resolve → transfer.deliverable.resolved); deliverable.acked{D03,D05,D06} once the final-tape set is in;
 *                               transfer.prelim_qc.completed (D02 + clean load report) | transfer.prelim_qc.blocked (differences → a corrected preliminary); transfer.final_accounting.acked (D31, + the advances-receivable entry set when the loans are given);
 *                               source=custodian → custody.transferor_notice.confirmed / custody.shipment.confirmed / custody.form2009.handed_off / custody.transferee_exception.received|resolved
 *   answerTransfereeRequest     op=receive → transferee_request.received; transferee_request.responded; op=window → transfer.support_window.expired
 *   notifyCounterparty          op=plan → transfer.counterparties.planned; counterparty_notification.sent, transfer.counterparty_notices.sent{group}, transfer.counterparties.notified;
 *                               op=ack → counterparty_notifications.acked{<group>}, transfer.counterparty_notices.acked{group, kind}
 *   verifyMersSnapshot          op=prepare (file) / op=submit → mers.txn.submitted (mers_transactions rows per MIN) / op=ack → mers.txn.accepted|rejected per MIN, mers.txn.accepted{all_mins} (+ mers.tos.pending_received for a TOS)
 *                               / snapshot → mers.snapshot.verified{all_mins} only when the snapshot covers every MIN of the batch and none shows Supermortgage
 *   verifyERegistry             enote.eregistry.updated{servicing_agent=transferee} per loan (with the eDelivery copies and audit trails acked) and on the batch once every eNote of the batch has it
 *   buildDebrief                transfer.debrief.completed; op=archive → transfer.archive.written{all_loans}; op=deidentify → transfer.archive.deidentified
 *
 * Guardrails encode the Agents paragraph: the agent may not alter any balance to make a tie-out pass;
 * attestation, the final accounting and any write-off require the Supermortgage `officer`; Fannie Mae
 * adjustment requests and MERS/TOS submissions under the partner's credentials require the partner
 * `officer`/`fnma_portal_operator` (the kernel Actor carries a role, not an organisation — the role is
 * the enforceable half; the submission record names the partner as submitter); `signing_officer` for
 * any assignment, allonge or Form 2009 execution (the custodian ops that execute them read the flag);
 * `attorney` for litigation-file hand-offs where counsel of record must substitute (the law-firm notice
 * carries the instruction); no borrower contact from 17.3; D27 fair-lending data only over the
 * restricted channel (19.4).
 */
import { defineTools, compute, never, needsRole, read, decision, cents, str, num, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { TimerDef } from "../../kernel/timers/registry.ts";
import type { DomainEvent } from "../../kernel/events/index.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import { ingestMersAcknowledgement } from "../../domain/transfers/inbound.ts";
import { planDeliverables, outboundDqGate, attestationGate, transfereeRequest, transfereeRequestBacklog, counterpartyStatus, counterpartyGroup, notificationKind, planCounterpartyNotifications, miNoticeCheck, finalCycleNoticeCheck, verifyMersSnapshot, minUpdateFile, outboundMersAckRows, enoteServicingAgentHandoff, enoteHandoffEvidence, buildDebrief, prelimQc, ackConditions, finalTapeSetAcked, deliveryAllowed, regenerationAllowed, cutoverFreeze, matchWires, ledgerAtFreeze, wireLedgerSets, advancesOnAckLedgerSet, shortageSurplusResolution, custodialAdjustmentWindow, custodialAccountDisposition, participationNotesHandoff, batchPopulationFacts, miTransferNotices, postTransferReceipt, misdirectedPaymentRow, forwardingFile, cbamLoaCancellation, form2009Handoff, supportWindow, archiveManifestStatus, retentionPlan, deidentify, DELIVERABLE_KINDS, DELIVERABLE_NEXT, DELIVERABLE_RECIPIENTS, type OutboundLoanTieOut, type CounterpartyNotification, type PartyType, type DeliverableKind, type DeliverableRecipient, type DeliverableStatus, type TransfereeRequestKind, type WireKind, type WireLoan, type ListedLoanFacts, type BatchPopulationFacts, type PostTransferReceipt } from "../../domain/transfers/ops-17-3.ts";
import type { LoanBalances } from "../../domain/transfers/reconciliation.ts";
import type { TransferType } from "../../domain/transfers/batch.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const list = <T>(i: ToolInput, k: string): T[] => (Array.isArray(i[k]) ? (i[k] as T[]) : []);
const obj = (i: ToolInput, k: string): Record<string, unknown> => (typeof i[k] === "object" && i[k] !== null ? (i[k] as Record<string, unknown>) : {});
const today = (ctx: CommandContext): PlainDate => D(ctx.now.slice(0, 10));
const batchAgg = (i: ToolInput) => ({ kind: "batch", id: str(i, "batch_id") });
const AGENT = "transfer";
const INSTRUMENT = /^(assignment|allonge|form2009|form_2009)$/i;
const BALANCE_FIELD = /(balance|upb|principal|escrow|unapplied|advance)/i;
let registryCache: ReturnType<typeof loadOverriddenRegistry> | null = null;
const registryDef = (code: string): TimerDef => { registryCache ??= loadOverriddenRegistry(); const d = registryCache.get(code); if (!d) throw new RangeError(`no timer ${code}`); return d; };

const noBalanceEdit = never("NO_BALANCE_EDIT", "17.3 guardrail: the agent may not alter any balance to make a tie-out pass — differences are categorized (1.6 taxonomy) and resolved with evidence or escalated",
  (i) => flag(i, "adjust_balances") || (typeof i.balance_overrides === "object" && i.balance_overrides !== null && Object.keys(i.balance_overrides as object).length > 0) || (typeof i.changes === "object" && i.changes !== null && Object.keys(i.changes).some((k) => BALANCE_FIELD.test(k))),
  "categorize the difference and resolve it with evidence or escalate; no balance edit");
const noBorrowerContact = never("NO_BORROWER_CONTACT", "17.3 guardrail: no borrower contact from 17.3 (17.2 owns borrower notices)", (i) => /^borrower$/i.test(str(i, "recipient")) || /^borrower$/i.test(str(i, "party_type")), "17.2 owns borrower communications");
const officerAttestation = needsRole("OFFICER_ATTESTATION", "17.3 guardrail: attestation, final accounting and any write-off require the Supermortgage officer",
  (i) => flag(i, "attest") || str(i, "kind") === "D31" || flag(i, "write_off") || (i.op === "shortage_surplus" && !flag(i, "request_adjustment")), ["officer"], "attestation / final accounting / shortage-surplus sign-off / write-off is an officer act");
const partnerCredentials = needsRole("PARTNER_CREDENTIALS", "17.3 guardrail: MERS/TOS submissions and Fannie Mae adjustment requests under the partner's credentials require the partner officer/fnma_portal_operator",
  (i) => i.op === "submit" || (i.op === "shortage_surplus" && flag(i, "request_adjustment")), ["officer", "fnma_portal_operator"], "prepare the file / the request; the partner's officer or fnma_portal_operator submits it");
const signingOfficer = needsRole("SIGNING_OFFICER_INSTRUMENT", "17.3 guardrail: signing_officer for any assignment, allonge or Form 2009 execution", (i) => flag(i, "execute") && INSTRUMENT.test(str(i, "instrument")), ["signing_officer"], "assignments, allonges and Form 2009s are executed by the signing officer");
const attorneySubstitution = needsRole("ATTORNEY_SUBSTITUTION", "17.3 guardrail: attorney for litigation-file hand-offs where counsel of record must substitute (17.4)", (i) => str(i, "party_type") === "law_firm" && (str(i, "instructions") === "substitute_counsel" || flag(i, "substitute_counsel")), ["attorney"], "counsel-of-record substitution is an attorney act");
const restrictedFairLending = never("D27_RESTRICTED_CHANNEL", "17.3 integrations: fair-lending data (D27) travels over a separate encrypted channel with restricted access logging (19.4)", (i) => str(i, "kind") === "D27" && str(i, "channel") !== "restricted", "send D27 over the restricted channel only");

/** Every counterparty row of a batch, with the derived timer group (the table stores party_type; the group is `counterpartyGroup(party_type)`). */
function counterpartyRows(rt: ToolRuntime, batchId: string): CounterpartyNotification[] {
  return rt.store.list("counterparty_notifications", (d) => d.batch_id === batchId).map((r) => { const d = r.data; const pt = d.party_type as PartyType; return { party_type: pt, party_id: String(d.party_id), loan_id: (d.loan_id as string | null) ?? null, kind: (d.kind as CounterpartyNotification["kind"]) ?? notificationKind(pt), group: counterpartyGroup(pt), due_at: d.due_at as PlainDate, sent_at: (d.sent_at as PlainDate | null) ?? null, acked_at: (d.acked_at as PlainDate | null) ?? null }; });
}
function counterpartyAckRows(rt: ToolRuntime, batchId: string): { group: string; kind: string; acked: boolean }[] {
  return rt.store.list("counterparty_notifications", (d) => d.batch_id === batchId).map((r) => ({ group: counterpartyGroup(r.data.party_type as PartyType), kind: String(r.data.kind), acked: Boolean(r.data.acked_at) }));
}
/** A batch has a planned counterparty population when some notification row of the batch was born `planned` (notifyCounterparty{op=plan}); a notice sent without a plan is born `sent`. Completeness (group sent / all due before T sent / group acked) is asserted only against a planned population. */
function counterpartyPlanned(rt: ToolRuntime, batchId: string): boolean {
  return rt.store.list("counterparty_notifications", (d) => d.batch_id === batchId).some((r) => rt.store.history("counterparty_notifications", r.id)[0]?.data.status === "planned");
}
/** The latest deliverable plan of a batch (its `transfer.deliverables.planned` event): the transfer date and the loan-list population facts the later ops read. */
function latestPlan(ctx: CommandContext, batchId: string): (BatchPopulationFacts & { transfer_date: PlainDate }) | null {
  const ev = ctx.events.ofType("transfer.deliverables.planned").filter((e) => e.aggregate?.kind === "batch" && e.aggregate.id === batchId).at(-1);
  if (!ev) return null; const p = ev.payload as Record<string, unknown>;
  return { transfer_date: p.transfer_date as PlainDate, loan_count: Number(p.loan_count ?? 0), fc_or_litigation: Number(p.fc_or_litigation ?? 0), bk: Number(p.bk ?? 0), emortgage_count: Number(p.emortgage_count ?? 0), participation_pool: Number(p.participation_pool ?? 0), mi_insurers: Array.isArray(p.mi_insurers) ? (p.mi_insurers as string[]) : [] };
}
const listedLoans = (i: ToolInput): ListedLoanFacts[] => list<Record<string, unknown>>(i, "loans").map((l) => ({ loan_id: String(l.loan_id ?? ""), foreclosure: l.foreclosure === true, litigation: l.litigation === true, bankruptcy: l.bankruptcy === true, enote: l.enote === true, mi: typeof l.mi === "string" ? l.mi : null, participation_pool: l.participation_pool === true }));
const explicitFacts = (i: ToolInput): Partial<BatchPopulationFacts> => ({ ...(Number.isNaN(num(i, "loan_count")) ? {} : { loan_count: num(i, "loan_count") }), ...(Number.isNaN(num(i, "fc_or_litigation")) ? {} : { fc_or_litigation: num(i, "fc_or_litigation") }), ...(Number.isNaN(num(i, "bk")) ? {} : { bk: num(i, "bk") }), ...(Number.isNaN(num(i, "emortgage_count")) ? {} : { emortgage_count: num(i, "emortgage_count") }), ...(Number.isNaN(num(i, "participation_pool")) ? {} : { participation_pool: num(i, "participation_pool") }), ...(Array.isArray(i.mi_insurers) ? { mi_insurers: (i.mi_insurers as unknown[]).map(String) } : {}) });
/** The MINs of a batch: the partner's submitted MERS transactions (mers_transactions rows) or the caller's list. */
const batchMins = (rt: ToolRuntime, i: ToolInput): string[] => { const given = list<{ min?: string } | string>(i, "mins").map((m) => (typeof m === "string" ? m : String(m.min ?? ""))).filter(Boolean); return given.length ? given : [...new Set(rt.store.list("mers_transactions", (d) => d.batch_id === str(i, "batch_id")).map((r) => String(r.data.min)))]; };

export const TOOLS_17_3: readonly ToolDef[] = defineTools("17.3", AGENT, [
  { name: "planDeliverables", kind: "write", handler: compute((i, ctx, rt) => { need(i, "batch_id"); const T = date(i, "transfer_date"); const agg = batchAgg(i);
      if (i.op === "cutover") {   // transfer.batch.cutover_completed → final tape, funds and final-period tasks: the cutover-time facts the 17.1 event does not carry (loan-list counts), from the caller or the approval-time plan
        const plan = latestPlan(ctx, str(i, "batch_id")); const facts = batchPopulationFacts(listedLoans(i), { ...(plan ?? {}), ...explicitFacts(i) });
        const h = participationNotesHandoff({ transfer_date: T, participation_pool: facts.participation_pool });   // participation-pool notes reach the transferee custodian within 30 days (FNMA_F1_11_PARTICIPATION_NOTES_30 arms on this event)
        if (h.event) ctx.events.append({ type: h.event.type, aggregate: agg, actor: ctx.actor, payload: { batch_id: str(i, "batch_id"), transfer_date: T, participation_pool: h.event.participation_pool, recipient: h.recipient, due: h.due } });
        const mi = miTransferNotices(T, facts.mi_insurers);   // one pending transfer notice per MI insurer (MGIC: within 60 days of the sale — MI_MGIC_TRANSFER_NOTICE_60 arms on the MGIC one)
        for (const n of mi) ctx.events.append({ type: n.event.type, aggregate: agg, actor: ctx.actor, payload: { batch_id: str(i, "batch_id"), transfer_date: T, mi: n.mi, due: n.due, send_by: n.send_by, timer: n.timer } });
        return { ...h, mi_notices: mi.map((n) => ({ mi: n.mi, due: n.due, send_by: n.send_by, timer: n.timer })), facts }; }
      const plan = planDeliverables(T); const facts = batchPopulationFacts(listedLoans(i), explicitFacts(i));
      for (const p of plan) rt.store.put("transfer_out_deliverables", `${str(i, "batch_id")}-${p.kind}`, { batch_id: str(i, "batch_id"), kind: p.kind, as_of: p.as_of, recipient: p.recipient, status: "planned", correction_seq: 0 }, ctx.actor, ctx.now);
      // the plan states the population facts the approval event lacks: SM_XFER_OUT_LAW_FIRM_NOTICE_T1 / SM_XFER_OUT_BK_TRUSTEE_NOTICE_T1 arm on them (timers-17-3.ts); the eNote count arms the shared 1.4 code on the batch
      const ev = ctx.events.append({ type: "transfer.deliverables.planned", aggregate: agg, actor: ctx.actor, payload: { batch_id: str(i, "batch_id"), direction: "out", type: str(i, "type") || null, transfer_date: T, count: plan.length, ...facts, mi_insurers: [...facts.mi_insurers] } });
      if (facts.emortgage_count > 0) ctx.timers.arm(registryDef("FNMA_F1_11_ENOTE_SERVICING_AGENT_T0"), ev);
      return { deliverables: plan, facts, enote_handoff_armed: facts.emortgage_count > 0 }; }) },
  { name: "generateDeliverable", kind: "write", guardrails: [noBalanceEdit], handler: compute((i, ctx, rt) => { need(i, "batch_id", "kind", "as_of"); const kind = str(i, "kind") as DeliverableKind; if (!(kind in DELIVERABLE_KINDS)) throw new RangeError(`unknown deliverable kind ${kind}`);
      const id = `${str(i, "batch_id")}-${kind}`; const prev = rt.store.get("transfer_out_deliverables", id)?.data; const from = (prev?.status as DeliverableStatus | undefined) ?? "planned";
      const re = regenerationAllowed(from, flag(i, "corrected")); if (!re.allowed) throw new RangeError(`deliverable ${kind}: ${re.refusal}`);
      const asOf = date(i, "as_of"); const plannedAsOf = typeof prev?.as_of === "string" && from === "planned" ? (prev.as_of as PlainDate) : null;
      if (kind === "D04" && plannedAsOf && asOf !== plannedAsOf) throw new RangeError(`D04 trial balance is as of close of business the day before transfer (${plannedAsOf}, F-1-11); got ${asOf}`);
      const mappingSet = "mismo-3.6-itsd-lbds@1.1-reversed"; const correction = from === "acked" ? Number(prev?.correction_seq ?? 0) + 1 : Number(prev?.correction_seq ?? 0);
      let rows = Number.isNaN(num(i, "row_count")) ? 0 : num(i, "row_count"); let forwarded: { loan_id: string; received_on: PlainDate; amount_cents: bigint }[] | null = null; let fileId: string | null = null;
      if (kind === "D32") {   // the daily forwarding file: every misdirected_payments{direction=out} row of the batch's listed loans not yet forwarded whose forwarding date (next servicer BD after receipt) is on or before the file date
        const listed = new Set(rt.store.list("payment_holds", (d) => d.owner_case_id === str(i, "batch_id") && d.hold_type === "transfer_out_cutover" && !d.released_at).map((r) => String(r.data.loan_id)));
        const pending = rt.store.list("misdirected_payments", (d) => d.direction === "out" && !d.forwarded_at && listed.has(String(d.loan_id)));
        const file = forwardingFile(asOf, pending.map((r) => ({ loan_id: String(r.data.loan_id), received_on: r.data.received_at as PlainDate, amount_cents: cents(r.data.amount_cents) })));
        fileId = `fwd-${str(i, "batch_id")}-${asOf}`; forwarded = file.rows; rows = file.rows.length;
        for (const r of pending) if (file.rows.some((x) => x.loan_id === String(r.data.loan_id) && x.received_on === r.data.received_at)) rt.store.put("misdirected_payments", r.id, { forwarded_at: ctx.now, forward_reference: fileId, disposition: "forwarded" }, ctx.actor, ctx.now); }
      const rec = rt.store.put("transfer_out_deliverables", id, { batch_id: str(i, "batch_id"), kind, as_of: asOf, format: str(i, "format") || (kind === "D32" ? "csv" : "mismo_xml"), document_id: str(i, "document_id") || fileId, row_count: rows, generated_at: ctx.now, validated_at: null, attested_at: null, delivered_at: null, acked_at: null, ack_reference: null, status: "generated", recipient: str(i, "recipient") || (prev?.recipient as string | undefined) || "transferee", correction_seq: correction }, ctx.actor, ctx.now);
      ctx.events.append({ type: "transfer.deliverable.generated", aggregate: batchAgg(i), actor: ctx.actor, payload: { kind, name: DELIVERABLE_KINDS[kind], as_of: asOf, document_id: rec.data.document_id, mapping_set: mappingSet, corrected: from === "acked", correction_seq: correction, row_count: rows } });
      return { ...rec.data, name: DELIVERABLE_KINDS[kind], mapping_set: mappingSet, corrected: from === "acked", ...(forwarded ? { file_id: fileId, rows: forwarded, total_cents: forwarded.reduce((a, r) => a + r.amount_cents, 0n) } : {}) }; }) },
  { name: "runOutboundDqGate", kind: "write", guardrails: [noBalanceEdit, officerAttestation, partnerCredentials], handler: compute((i, ctx, rt) => {
      switch (i.op ?? "dq") {
        case "freeze": {   // custodial-recon freezeLedgers: COB T−1 after the last posting batch; no postings dated ≥ T; holds on every loan (payment_holds{transfer_out_cutover}, owner case = the transfer-out batch)
          need(i, "batch_id", "transfer_date", "loans"); const T = date(i, "transfer_date");
          const f = cutoverFreeze({ transfer_date: T, frozen_on: optDate(i, "frozen_on") ?? today(ctx), loans: list<string>(i, "loans"), postings: list<{ loan_id: string; effective_date: PlainDate }>(i, "postings"), last_posting_batch_closed: i.last_posting_batch_closed !== false });
          if (!f.allowed) throw new RangeError(f.refusal!);
          for (const h of f.holds) rt.store.put("payment_holds", `${h.loan_id}-transfer_out_cutover`, { loan_id: h.loan_id, hold_type: h.hold, owner_case_id: str(i, "batch_id"), set_by: `${ctx.actor.kind}:${ctx.actor.id}`, set_at: ctx.now, released_at: null }, ctx.actor, ctx.now);
          ctx.events.append({ type: "transfer.cutover.frozen", aggregate: batchAgg(i), actor: ctx.actor, payload: { batch_id: str(i, "batch_id"), transfer_date: T, holds: f.holds.length, frozen_on: optDate(i, "frozen_on") ?? today(ctx) } }); return f; }
        case "receipt": {   // SM_XFER_OUT_POST_T_EVENT_GATE: a payment received on/after T for a listed loan is a misdirected payment (direction out) — the posting command is refused; no payment.received, no investor event; the row rides the next servicer-BD forwarding file (D32)
          need(i, "batch_id", "loan_id", "received_on", "transfer_date", "amount_cents", "payment_id"); const amt = cents(i.amount_cents); if (amt <= 0n) throw new RangeError("amount_cents must be positive");
          const channel = (str(i, "channel") || "lockbox") as PostTransferReceipt["channel"]; if (!["lockbox", "ach", "web", "branch", "trustee", "wire"].includes(channel)) throw new RangeError(`channel ${channel} is not lockbox / ach / web / branch / trustee / wire`);
          const listed = i.listed === undefined ? Boolean(rt.store.get("payment_holds", `${str(i, "loan_id")}-transfer_out_cutover`)?.data.owner_case_id === str(i, "batch_id")) : flag(i, "listed");
          const receipt: PostTransferReceipt & { payment_id: string } = { loan_id: str(i, "loan_id"), received_on: date(i, "received_on"), transfer_date: date(i, "transfer_date"), listed, channel, amount_cents: amt, payment_id: str(i, "payment_id") };
          const r = postTransferReceipt(receipt); const row = misdirectedPaymentRow(receipt);
          if (row) { const { forwarding_file_date, ...cols } = row; rt.store.put("misdirected_payments", str(i, "payment_id"), cols, ctx.actor, ctx.now);
            ctx.events.append({ type: "transfer.misdirected_payment.recorded", loanId: str(i, "loan_id"), aggregate: batchAgg(i), actor: ctx.actor, payload: { batch_id: str(i, "batch_id"), payment_id: str(i, "payment_id"), loan_id: str(i, "loan_id"), direction: "out", received_at: receipt.received_on, amount_cents: String(amt), instrument: cols.instrument, forwarding_file_date, gate: r.gate, refusal: r.refusal } }); }
          return { ...r, misdirected_payment: row ? { ...row, amount_cents: row.amount_cents } : null }; }
        case "match_wires": {   // custodial-recon computeWires/matchWires: wires matched to the trial-balance totals; variances to the officer, never adjusted; matched wires post the T&I / P&I entry sets when the custodial account ids are given
          need(i, "batch_id", "loans"); const loans = list<Record<string, unknown>>(i, "loans").map(balances); const m = matchWires({ loans, confirmations: list<{ kind: WireKind; amount_cents: unknown; reference: string }>(i, "confirmations").map((c) => ({ kind: c.kind, amount_cents: cents(c.amount_cents), reference: c.reference })) });
          let posted: string[] = [];
          if (m.event) { const acct = { pi: str(i, "pi_custodial_account_id"), ti: str(i, "ti_custodial_account_id") }; const wl = list<Record<string, unknown>>(i, "loans").filter((l) => typeof l.loan_id === "string").map((l) => ({ ...balances(l), loan_id: String(l.loan_id) } as WireLoan));
            if (acct.pi && acct.ti && wl.length === loans.length) { const sets = wireLedgerSets({ loans: wl, pi_custodial_account_id: acct.pi, ti_custodial_account_id: acct.ti, effective_date: optDate(i, "wired_on") ?? today(ctx), batch_id: str(i, "batch_id") }); posted = [sets.ti, sets.pi].filter((s): s is NonNullable<typeof s> => s !== null).map((s) => ctx.ledger.post(s, ctx.now).id); }
            ctx.events.append({ type: m.event, aggregate: batchAgg(i), actor: ctx.actor, payload: { batch_id: str(i, "batch_id"), ti_cents: String(m.expected.ti_cents), pi_cents: String(m.expected.pi_cents), ledger_set_ids: posted } }); }
          else if (m.escalation) { ctx.events.append({ type: "recon.transfer_out_wires.variance", aggregate: batchAgg(i), actor: ctx.actor, payload: { batch_id: str(i, "batch_id"), variances: m.variances.map((v) => ({ kind: v.kind, variance_cents: String(v.variance_cents) })) } }); rt.escalations.open({ kind: "officer", batchId: str(i, "batch_id"), severity: m.escalation.severity ?? "sev1", payload: { reason: m.escalation.reason } }, ctx.actor); }
          return { ...m, ledger_set_ids: posted }; }
        case "final_accounting": { need(i, "batch_id", "loans"); return { kind: "D31", ...ledgerAtFreeze(list<Record<string, unknown>>(i, "loans").map(balances)) }; }   // custodial-recon buildFinalAccounting (D31 figures: wires, advances receivable); signing = the officer attestation on D31
        case "shortage_surplus": {   // custodial-recon reconcileShortageSurplus (F-1-11 T+30): the partner officer's adjustment request, or the officer-signed zero-unresolved reconciliation
          need(i, "batch_id", "transfer_date"); const T = date(i, "transfer_date");
          const r = shortageSurplusResolution({ transfer_date: T, unresolved_cents: cents(i.unresolved_cents), adjustment_request_document_id: str(i, "adjustment_request_document_id") || null, signed_by: ctx.actor.kind === "human" ? { kind: "human", id: ctx.actor.id, ...(ctx.actor.role ? { role: ctx.actor.role } : {}) } : { kind: "agent", id: ctx.actor.id } });
          if (r.refusal) throw new RangeError(r.refusal);
          for (const type of r.events) ctx.events.append({ type, aggregate: batchAgg(i), actor: ctx.actor, payload: { batch_id: str(i, "batch_id"), outcome: r.outcome, unresolved_cents: String(cents(i.unresolved_cents)), adjustment_request_document_id: str(i, "adjustment_request_document_id") || null, due: r.due } });
          return r; }
        case "custodial_window": {   // FNMA_F1_11_CUSTODIAL_RECON_5BD satisfied for every account + T+30 window closed with no open variance → SM_XFER_OUT_CUSTODIAL_CLOSE_60
          need(i, "batch_id", "transfer_date", "custodial_accounts"); const T = date(i, "transfer_date");
          const acks = rt.store.list("transfer_out_custodial_recon_acks", (d) => d.batch_id === str(i, "batch_id")).map((r) => ({ account_id: String(r.data.custodial_account_id), acked_on: r.data.acked_on as PlainDate }));
          const w = custodialAdjustmentWindow({ transfer_date: T, today: optDate(i, "today") ?? today(ctx), custodial_accounts: list<string>(i, "custodial_accounts"), recon_acks: acks, open_variance: flag(i, "open_variance") });
          if (w.event) ctx.events.append({ type: w.event.type, aggregate: batchAgg(i), actor: ctx.actor, payload: { batch_id: str(i, "batch_id"), adjustment_window_closed: true, open_variance: false, recon_acked_on: w.event.recon_acked_on } });
          return w; }
        case "custodial_disposition": {   // fully-vacated account: zero balance, Forms 1013/1014 withdrawn (human_portal_task, partner countersignature), bank closure letter; retained loans: reconciliation certificate
          need(i, "batch_id", "account_id", "recon_acked_on");
          const d = custodialAccountDisposition({ account_id: str(i, "account_id"), recon_acked_on: date(i, "recon_acked_on"), adjustment_window_closed: i.adjustment_window_closed !== false, open_variance: flag(i, "open_variance"), population_fully_transferred: flag(i, "population_fully_transferred"), balance_cents: cents(i.balance_cents), forms_1013_1014_withdrawn: flag(i, "forms_1013_1014_withdrawn"), bank_closure_letter_document_id: str(i, "bank_closure_letter_document_id") || null, recon_certificate_document_id: str(i, "recon_certificate_document_id") || null });
          if (d.portal_task) rt.escalations.open({ kind: "human_portal_task", batchId: str(i, "batch_id"), payload: { portal: d.portal_task.portal, action: d.portal_task.action, countersignature: d.portal_task.countersignature, account_id: str(i, "account_id") } }, ctx.actor);
          if (d.event) ctx.events.append({ type: d.event.type, aggregate: batchAgg(i), actor: ctx.actor, payload: { batch_id: str(i, "batch_id"), account_id: d.event.account_id, outcome: d.event.outcome } });
          return d; }
        case "final_draft_cleared": {   // final-period remittance draft cleared + final Form 496/496A (6.3/6.4) → SM_XFER_OUT_CUSTODIAL_ACCOUNT_CLOSE (CBAM LOA cancellation, +10 servicer BD)
          need(i, "batch_id", "cleared_on"); const on = date(i, "cleared_on"); const last = flag(i, "last_batch_for_partner");
          ctx.events.append({ type: "transfer.final_remittance.cleared", aggregate: batchAgg(i), actor: ctx.actor, payload: { batch_id: str(i, "batch_id"), cleared_on: on, last_batch_for_partner: last, form_496_final: flag(i, "form_496_final") } });
          const c = cbamLoaCancellation({ last_batch_for_partner: last, draft_cleared_on: on });
          if (c.task) rt.escalations.open({ kind: "human_portal_task", batchId: str(i, "batch_id"), payload: { portal: c.task.portal, action: c.task.action, due: c.task.due, task: "cbam_loa_cancellation" } }, ctx.actor);
          return c; }
        case "settlement": {   // custodial-recon postSettlement: the transferee's advances reimbursement — Dr cash / Cr the receivable (due_from_transferee; kernel account advance_receivable)
          need(i, "batch_id", "amount_cents", "received_on"); const amt = cents(i.amount_cents); if (amt <= 0n) throw new RangeError("settlement amount must be positive");
          const set = ctx.ledger.post({ effectiveDate: date(i, "received_on"), description: `advances reimbursement from the transferee (batch ${str(i, "batch_id")})`, lines: [{ account: { scope: "corporate", account: "corporate_cash" }, amountCents: amt, ruleRef: "17.3 funds: advance_reimbursement_in", memo: "F-1-11 advances reimbursement received" }, { account: { scope: "corporate", account: "advance_receivable" }, amountCents: -amt, ruleRef: "17.3 funds: advance_reimbursement_in", memo: "due_from_transferee" }] }, ctx.now);
          ctx.events.append({ type: "ledger.posted", aggregate: batchAgg(i), actor: ctx.actor, payload: { advance_reimbursement_in: true, amount_cents: String(amt), set_id: set.id, batch_id: str(i, "batch_id") } });
          ctx.events.append({ type: "transfer.advances.reimbursed", aggregate: batchAgg(i), actor: ctx.actor, payload: { batch_id: str(i, "batch_id"), amount_cents: String(amt), received_on: str(i, "received_on") } });
          return { set_id: set.id, amount_cents: amt, receivable_account: "due_from_transferee" }; }
        default: {
          need(i, "batch_id", "loans"); const loans = list<OutboundLoanTieOut>(i, "loans").map((l) => ({ ...l, tape_upb_cents: cents(l.tape_upb_cents), trial_balance_upb_cents: cents(l.trial_balance_upb_cents), ledger_principal_cents: cents(l.ledger_principal_cents), ...(l.fnma_position_upb_cents != null ? { fnma_position_upb_cents: cents(l.fnma_position_upb_cents) } : {}) }));
          const dq = outboundDqGate({ loans, hard_rule_failures: list(i, "hard_rule_failures"), ...(Number.isNaN(num(i, "document_count")) ? {} : { document_count: num(i, "document_count") }), ...(Number.isNaN(num(i, "image_index_count")) ? {} : { image_index_count: num(i, "image_index_count") }) });
          const attestation = flag(i, "attest") ? attestationGate({ dq, as_of: date(i, "as_of"), attested_by: { kind: ctx.actor.kind === "human" ? "human" : "agent", id: ctx.actor.id, ...(ctx.actor.role ? { role: ctx.actor.role } : {}) }, scorecard_document_id: str(i, "scorecard_document_id") || null }) : null;
          ctx.events.append({ type: dq.passed ? "transfer.deliverable.validated" : "transfer.dq_gate.failed", aggregate: batchAgg(i), actor: ctx.actor, payload: { passed: dq.passed, hard_failures: dq.hard_failures.length, rule_set_version: dq.rule_set_version } });
          if (dq.passed && str(i, "deliverable_kind")) { const id = `${str(i, "batch_id")}-${str(i, "deliverable_kind")}`; const prev = rt.store.get("transfer_out_deliverables", id)?.data; if (prev && DELIVERABLE_NEXT[(prev.status as DeliverableStatus) ?? "planned"].includes("validated")) rt.store.put("transfer_out_deliverables", id, { validated_at: ctx.now, status: attestation?.allowed ? "attested" : "validated", ...(attestation?.allowed ? { attested_at: ctx.now } : {}) }, ctx.actor, ctx.now); }
          if (attestation?.allowed) { rt.store.put("transfer_out_attestations", `${str(i, "batch_id")}-${str(i, "deliverable_id") || "batch"}`, { batch_id: str(i, "batch_id"), deliverable_id: str(i, "deliverable_id") || null, dq_scorecard_document_id: str(i, "scorecard_document_id"), tie_outs: dq.totals, attested_by: ctx.actor.id, attested_at: ctx.now, statement_text_version: dq.rule_set_version }, ctx.actor, ctx.now); const st = attestation.statement!; ctx.events.append({ type: "transfer.deliverable.attested", aggregate: batchAgg(i), actor: ctx.actor, payload: { as_of: st.as_of, rule_set_version: st.rule_set_version, scorecard_document_id: st.scorecard_document_id, attested_by: st.attested_by, tie_outs: Object.fromEntries(Object.entries(st.tie_outs).map(([k, v]) => [k, v === null ? null : String(v)])) } }); }
          return { ...dq, attestation }; }
      } }) },
  { name: "buildTrialBalance", kind: "read", handler: compute((i) => { need(i, "as_of", "loans"); const asOf = date(i, "as_of");
      const rows = list<Record<string, unknown>>(i, "loans").map((l) => ({ fnma_loan_number: l.fnma_loan_number ?? null, servicer_loan_number: l.loan_id ?? l.servicer_loan_number ?? null, borrower: l.borrower ?? null, property: l.property ?? null, remittance_type: l.remittance_type ?? null, remittance_cycle: l.remittance_cycle ?? null, participation_pct: l.participation_pct ?? "100", pool_number: l.pool_number ?? null,
        upb_cents: cents(l.upb_cents), lpi_date: l.lpi_date ?? null, next_due_date: l.next_due_date ?? null, note_rate_pct: l.note_rate_pct ?? null, pi_cents: cents(l.pi_cents), escrow_cents: cents(l.escrow_cents), escrow_advances_cents: cents(l.escrow_advances_cents), corporate_advances_cents: cents(l.corporate_advances_cents), curtailments_in_period_cents: cents(l.curtailments_in_period_cents), unapplied_cents: cents(l.unapplied_cents), loss_draft_cents: cents(l.loss_draft_cents), buydown_cents: cents(l.buydown_cents),
        regx_days_delinquent: l.regx_days_delinquent ?? 0, fnma_delinquency_status: l.fnma_delinquency_status ?? "current", foreclosure: l.foreclosure === true, bankruptcy: l.bankruptcy === true, reo: l.reo === true, pending_payoff: l.pending_payoff === true, pending_modification: l.pending_modification === true, pending_transfer: l.pending_transfer === true, mi: l.mi === true, enote: l.enote === true, custodian: l.custodian ?? null, min: l.min ?? null, acp: l.acp === true, recert_list: l.enote === true ? false : true }));
      return { kind: "D04", as_of: asOf, rows, totals: { upb_cents: rows.reduce((a, r) => a + r.upb_cents, 0n), escrow_cents: rows.reduce((a, r) => a + r.escrow_cents, 0n), unapplied_cents: rows.reduce((a, r) => a + r.unapplied_cents, 0n), count: rows.length } }; }) },
  { name: "buildImageIndex", kind: "read", handler: compute((i) => { need(i, "documents"); const rows = list<Record<string, unknown>>(i, "documents").map((d) => { if (!d.sha256) throw new RangeError("every image row needs a sha256"); return { loan_number: d.loan_number ?? null, document_type: d.document_type ?? null, date: d.date ?? null, page_count: Number(d.page_count ?? 0), sha256: d.sha256 }; });
      const expected = num(i, "document_count"); return { kind: "D28", file: "image_index.csv", rows, count: rows.length, reconciled_to_document_count: Number.isNaN(expected) ? null : rows.length === expected }; }) },
  { name: "sendDeliverable", kind: "act", guardrails: [noBorrowerContact, officerAttestation, restrictedFairLending], handler: compute((i, ctx, rt) => { need(i, "batch_id", "kind", "channel"); const kind = str(i, "kind") as DeliverableKind; const id = `${str(i, "batch_id")}-${kind}`; const prev = rt.store.get("transfer_out_deliverables", id)?.data; const from = (prev?.status as DeliverableStatus | undefined) ?? "planned";
      const ok = deliveryAllowed(from, flag(i, "resend")); if (!ok.allowed) throw new RangeError(`deliverable ${kind}: ${ok.refusal}`);
      const recipient = (str(i, "recipient") || (prev?.recipient as string | undefined) || "transferee") as DeliverableRecipient;   // the 0019 recipient enum — a deliverable never goes to a borrower (17.2 owns borrower notices)
      if (!DELIVERABLE_RECIPIENTS.includes(recipient)) throw new RangeError(`deliverable recipient ${recipient} is not one of ${DELIVERABLE_RECIPIENTS.join(", ")}`);
      const rec = rt.store.put("transfer_out_deliverables", id, { batch_id: str(i, "batch_id"), kind, delivered_at: ctx.now, delivery_channel: str(i, "channel"), recipient, status: "delivered" }, ctx.actor, ctx.now);
      ctx.events.append({ type: "transfer.deliverable.delivered", aggregate: batchAgg(i), actor: ctx.actor, payload: { kind, channel: str(i, "channel"), recipient: rec.data.recipient, document_id: prev?.document_id ?? null, resend: flag(i, "resend"), resend_after_business_days: 2 } });
      if (kind === "D31") ctx.events.append({ type: "transfer.final_accounting.delivered", aggregate: batchAgg(i), actor: ctx.actor, payload: { batch_id: str(i, "batch_id"), document_id: prev?.document_id ?? null } });
      return rec.data; }) },
  { name: "ingestTransfereeAck", kind: "write", guardrails: [signingOfficer], handler: compute((i, ctx, rt) => {
      if (i.source === "custodian") return custodianFeed(i, ctx, rt);
      if (i.op === "resolve") {   // exception → resolved: the corrected deliverable is regenerated, validated, attested and re-delivered (the ladder), then acknowledged
        need(i, "batch_id", "kind", "resolution"); const kind = str(i, "kind") as DeliverableKind; const id = `${str(i, "batch_id")}-${kind}`; const prev = rt.store.get("transfer_out_deliverables", id)?.data; const from = (prev?.status as DeliverableStatus | undefined) ?? "planned";
        if (!DELIVERABLE_NEXT[from].includes("resolved")) throw new RangeError(`deliverable ${kind} is ${from}; only an exception is resolved`);
        const rec = rt.store.put("transfer_out_deliverables", id, { batch_id: str(i, "batch_id"), kind, status: "resolved" }, ctx.actor, ctx.now);
        ctx.events.append({ type: "transfer.deliverable.resolved", aggregate: batchAgg(i), actor: ctx.actor, payload: { kind, resolution: str(i, "resolution"), next: "generated" } }); return rec.data; }
      need(i, "batch_id", "kind", "ack_reference"); const kind = str(i, "kind") as DeliverableKind; if (!(kind in DELIVERABLE_KINDS)) throw new RangeError(`unknown deliverable kind ${kind}`); const id = `${str(i, "batch_id")}-${kind}`; const prev = rt.store.get("transfer_out_deliverables", id)?.data ?? null;
      const exceptions = list<{ row: number; issue: string }>(i, "exceptions"); const agg = batchAgg(i); const asOf = optDate(i, "as_of");
      // the transfer date the D04 condition (as_of = T−1) is measured against: the caller's, else the batch's deliverable plan (planDeliverables on the approval)
      const transferDate = optDate(i, "transfer_date") ?? latestPlan(ctx, str(i, "batch_id"))?.transfer_date ?? null;
      const cond = ackConditions({ kind, stored: prev, as_of: asOf, transfer_date: transferDate, load_report: i.load_report ?? null, index_count: Number.isNaN(num(i, "index_count")) ? null : num(i, "index_count"), document_count: Number.isNaN(num(i, "document_count")) ? null : num(i, "document_count"), custodial_accounts: list<string>(i, "custodial_accounts"), accounts_acked: list<string>(i, "accounts_acked") });
      if (cond.ladder_violation) throw new RangeError(cond.refusal!);
      if (exceptions.length || !cond.ok) {   // the transferee's exception file, or an acknowledgment that does not meet the F-1-11 condition, is an exception to resolve — never a satisfaction
        const rec = rt.store.put("transfer_out_deliverables", id, { batch_id: str(i, "batch_id"), kind, ack_reference: str(i, "ack_reference"), status: "exception" }, ctx.actor, ctx.now);
        ctx.events.append({ type: "transfer.deliverable.exception", aggregate: agg, actor: ctx.actor, payload: { kind, exceptions, condition: cond.refusal } }); return { ...rec.data, exceptions, refusal: cond.refusal, prelim_qc: null }; }
      const correctionSeq = Number(prev?.correction_seq ?? 0); const ackedOn = str(i, "acked_at") ? str(i, "acked_at").slice(0, 10) : today(ctx);
      const rec = rt.store.put("transfer_out_deliverables", id, { batch_id: str(i, "batch_id"), kind, acked_at: str(i, "acked_at") || ctx.now, ack_reference: str(i, "ack_reference"), status: "acked" }, ctx.actor, ctx.now);
      ctx.events.append({ type: "deliverable.acked", aggregate: agg, actor: ctx.actor, payload: { [kind]: true, kind, ack_reference: str(i, "ack_reference"), as_of: asOf, correction_seq: correctionSeq, ...(cond.every_account !== null ? { every_account: cond.every_account } : {}) } });
      ctx.events.append({ type: "transfer.deliverable.acked", aggregate: agg, actor: ctx.actor, payload: { kind, ack_reference: str(i, "ack_reference"), as_of: asOf, correction_seq: correctionSeq } });
      // D08: one transfer_out_custodial_recon_acks row (0044) per Supermortgage custodial account the acknowledgment covered — the T+30 window (op=custodial_window) and SM_XFER_OUT_CUSTODIAL_CLOSE_60 read the latest acked_on
      if (kind === "D08") for (const a of list<string>(i, "accounts_acked")) rt.store.put("transfer_out_custodial_recon_acks", `${str(i, "batch_id")}-${a}-${ackedOn}`, { batch_id: str(i, "batch_id"), custodial_account_id: a, deliverable_id: id, acked_on: ackedOn, ack_reference: str(i, "ack_reference") }, ctx.actor, ctx.now);
      let advances: { set_id: string | null; due_from_transferee_cents: bigint; reclassified_cents: bigint } | null = null;
      if (kind === "D31") {   // FNMA_F1_11_FINAL_ACCOUNTING_30: the transferee received the accounting (received_on); with the loan balances given, the advances receivable is recognized (Dr due_from_transferee / Cr escrow_advances, corporate_advances) as of the ack
        const wl = list<Record<string, unknown>>(i, "loans").filter((l) => typeof l.loan_id === "string").map((l) => ({ ...balances(l), loan_id: String(l.loan_id) } as WireLoan));
        const set = wl.length ? advancesOnAckLedgerSet({ loans: wl, effective_date: D(ackedOn), batch_id: str(i, "batch_id") }) : null;
        const setId = set?.set ? ctx.ledger.post(set.set, ctx.now).id : null;
        if (set) advances = { set_id: setId, due_from_transferee_cents: set.due_from_transferee_cents, reclassified_cents: set.reclassified_cents };
        ctx.events.append({ type: "transfer.final_accounting.acked", aggregate: agg, actor: ctx.actor, payload: { batch_id: str(i, "batch_id"), ack_reference: str(i, "ack_reference"), received_on: ackedOn, document_id: (prev?.document_id as string | null | undefined) ?? null, ledger_set_id: setId, due_from_transferee_cents: set ? String(set.due_from_transferee_cents) : null } }); }
      const acked = rt.store.list("transfer_out_deliverables", (d) => d.batch_id === str(i, "batch_id") && d.status === "acked").map((r) => r.data.kind as DeliverableKind);
      const fin = finalTapeSetAcked(acked); if (["D03", "D05", "D06"].includes(kind) && fin.event) ctx.events.append({ type: fin.event.type, aggregate: agg, actor: ctx.actor, payload: { D03: true, D05: true, D06: true, group: "final_tape" } });
      // D02 (Bulletin 2020-02 preliminary QC; SM_XFER_OUT_PRELIM_QC_7 arms on this ack): the transferee-system values must match the submitted preliminary — a load report with mapping differences
      // blocks `transfer.prelim_qc.completed` until a corrected preliminary (generateDeliverable{corrected=true} → the ladder → this ack again, correction_seq + 1) is acknowledged with a clean load report
      const qc = kind === "D02" ? prelimQc({ load_report: (i.load_report as { differences: { field: string; loan_count: number }[] }) ?? null, corrected_preliminary_acked: flag(i, "corrected_preliminary") || correctionSeq > 0 }) : null;
      if (qc?.event) ctx.events.append({ type: qc.event, aggregate: agg, actor: ctx.actor, payload: { kind, correction_seq: correctionSeq, ack_reference: str(i, "ack_reference") } });
      else if (qc && qc.blocking.length) ctx.events.append({ type: "transfer.prelim_qc.blocked", aggregate: agg, actor: ctx.actor, payload: { kind, correction_seq: correctionSeq, differences: qc.blocking.map((d) => ({ field: d.field, loan_count: d.loan_count })), corrective_action: qc.corrective_action, timer: qc.timer } });
      return { ...rec.data, prelim_qc: qc, final_tape_set_complete: fin.complete, advances }; }) },
  { name: "answerTransfereeRequest", kind: "act", guardrails: [noBorrowerContact], handler: compute((i, ctx, rt) => {
      if (i.op === "window") {   // the day-91 sweep: forwarding daily and 5-BD requests through T+90, on receipt / 10 BD after (decision 3)
        need(i, "batch_id", "transfer_date"); const w = supportWindow({ transfer_date: date(i, "transfer_date"), today: optDate(i, "today") ?? today(ctx) });
        if (w.event) ctx.events.append({ type: w.event, aggregate: batchAgg(i), actor: ctx.actor, payload: { batch_id: str(i, "batch_id"), window_end: w.window_end } }); return w; }
      if (i.op === "receive") {   // inbound `transferee_request.received` → SM_XFER_OUT_TRANSFEREE_REQUEST_5BD (+5 servicer BD from received_at)
        need(i, "batch_id", "request_id", "received_on", "transfer_date", "kind"); const r = transfereeRequest({ received_on: date(i, "received_on"), transfer_date: date(i, "transfer_date"), kind: str(i, "kind") as TransfereeRequestKind });
        const rec = rt.store.put("transferee_requests", str(i, "request_id"), { batch_id: str(i, "batch_id"), loan_id: str(i, "loan_id") || null, received_at: str(i, "received_on"), kind: str(i, "kind"), due_at: r.due, responded_at: null, response_document_id: null, status: "open" }, ctx.actor, ctx.now);
        ctx.events.append({ type: "transferee_request.received", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, aggregate: { kind: "transferee_request", id: str(i, "request_id") }, actor: ctx.actor, payload: { request_id: str(i, "request_id"), batch_id: str(i, "batch_id"), received_at: str(i, "received_on"), kind: str(i, "kind"), due: r.due } });
        const open = rt.store.list("transferee_requests", (d) => d.batch_id === str(i, "batch_id") && d.status === "open").length; const esc = transfereeRequestBacklog(open); if (esc) rt.escalations.open({ kind: "officer", batchId: str(i, "batch_id"), severity: esc.severity ?? "sev2", payload: { reason: esc.reason } }, ctx.actor);
        return { ...rec.data, ...r, open_requests: open, escalation: esc }; }
      need(i, "batch_id", "request_id", "received_on", "transfer_date", "kind"); const doc = (i.document as { id: string; sha256: string } | undefined) ?? null; if (str(i, "kind") === "missing_document" && !doc?.sha256) throw new RangeError("a missing-document answer carries the document id and sha256");
      const r = transfereeRequest({ received_on: date(i, "received_on"), transfer_date: date(i, "transfer_date"), kind: str(i, "kind") as TransfereeRequestKind, document: doc, responded_on: optDate(i, "responded_on") ?? today(ctx) });
      const rec = rt.store.put("transferee_requests", str(i, "request_id"), { batch_id: str(i, "batch_id"), loan_id: str(i, "loan_id") || null, received_at: str(i, "received_on"), kind: str(i, "kind"), due_at: r.due, responded_at: ctx.now, response_document_id: doc?.id ?? null, status: "responded" }, ctx.actor, ctx.now);
      ctx.events.append({ type: "transferee_request.responded", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, aggregate: { kind: "transferee_request", id: str(i, "request_id") }, actor: ctx.actor, payload: { request_id: str(i, "request_id"), due: r.due, on_time: r.on_time, document_id: doc?.id ?? null, document_hash: doc?.sha256 ?? null } }); return { ...rec.data, ...r }; }) },
  { name: "notifyCounterparty", kind: "act", guardrails: [noBorrowerContact, attorneySubstitution], handler: compute((i, ctx, rt) => {
      const agg = batchAgg(i);
      if (i.op === "plan") {   // the planned population: every party due T−1 servicer BD (transferor custodian at approval; bureaus / custodial bank at T); completeness is measured against it
        need(i, "batch_id", "transfer_date", "approved_on", "parties"); const plan = planCounterpartyNotifications({ transfer_date: date(i, "transfer_date"), approved_on: date(i, "approved_on"), parties: list<{ party_type: PartyType; party_id: string; loan_id?: string | null }>(i, "parties") });
        for (const n of plan) { const id = `${str(i, "batch_id")}-${n.party_type}-${n.party_id}`; if (!rt.store.get("counterparty_notifications", id)) rt.store.put("counterparty_notifications", id, { batch_id: str(i, "batch_id"), loan_id: n.loan_id ?? null, party_type: n.party_type, party_id: n.party_id, kind: n.kind, due_at: n.due_at, sent_at: null, channel: null, document_id: null, acked_at: null, status: "planned" }, ctx.actor, ctx.now); }
        ctx.events.append({ type: "transfer.counterparties.planned", aggregate: agg, actor: ctx.actor, payload: { batch_id: str(i, "batch_id"), count: plan.length, due_before_transfer: plan.filter((n) => n.due_at < date(i, "transfer_date")).length } }); return plan; }
      need(i, "batch_id", "party_type", "party_id", "transfer_date"); const pt = str(i, "party_type") as PartyType; const T = date(i, "transfer_date"); const group = counterpartyGroup(pt);
      const id = str(i, "id") || `${str(i, "batch_id")}-${pt}-${str(i, "party_id")}`; const prev = rt.store.get("counterparty_notifications", id)?.data;
      if (i.op === "ack") {   // the counterparty's acknowledgment (MI, insurer, vendor, law firm, bureau acceptance of the final cycle, …)
        if (!prev || !prev.sent_at) throw new RangeError(`no sent notice ${id} to acknowledge`);
        if (pt === "credit_bureau") { const c = finalCycleNoticeCheck(obj(i, "notice"), T); if (!c.ok) throw new RangeError(`bureau acceptance is of the final cycle: ${c.problems.join("; ")}`); }
        const rec = rt.store.put("counterparty_notifications", id, { acked_at: str(i, "acked_on") || today(ctx), status: "acked" }, ctx.actor, ctx.now);
        // the MI ack carries the insurer as `mi=<party_id>` so MI_MGIC_TRANSFER_NOTICE_60 (`counterparty_notifications.acked{mi=MGIC}`) closes on MGIC's own acknowledgment, not Radian's or Enact's; other groups carry `<group>=true`
        ctx.events.append({ type: "counterparty_notifications.acked", aggregate: agg, actor: ctx.actor, payload: { ...(group === "mi" ? { mi: str(i, "party_id") } : { [group]: true }), group, party_type: pt, party_id: str(i, "party_id"), kind: rec.data.kind, batch_id: str(i, "batch_id") } });
        // group completeness ("accepted by all bureaus", MGIC's own ack) is measured against the planned population only — without a plan the first ack would "complete" its group
        const rows = counterpartyAckRows(rt, str(i, "batch_id")).filter((r) => r.group === group); const complete = counterpartyPlanned(rt, str(i, "batch_id")) && rows.length > 0 && rows.every((r) => r.acked);
        if (complete) ctx.events.append({ type: "transfer.counterparty_notices.acked", aggregate: agg, actor: ctx.actor, payload: { group, kind: rec.data.kind, batch_id: str(i, "batch_id"), count: rows.length } });
        return { ...rec.data, group, group_acked: complete }; }
      if (pt === "mi") { const c = miNoticeCheck(obj(i, "notice")); if (!c.ok) throw new RangeError(`MI transfer notice is missing ${c.missing.join(", ")} (MGIC Servicing Guide: certificate, borrower, selling servicer, new servicer name/address, new loan number, effective date, requestor)`); }
      if (pt === "credit_bureau") { const c = finalCycleNoticeCheck(obj(i, "notice"), T); if (!c.ok) throw new RangeError(`final cycle to the bureaus: ${c.problems.join("; ")}`); }
      const instructions = pt === "law_firm" ? (str(i, "instructions") || (flag(i, "substitute_counsel") ? "substitute_counsel" : "hold")) : null;
      if (instructions && !["hold", "proceed", "substitute_counsel"].includes(instructions)) throw new RangeError(`law-firm instructions must be hold / proceed / substitute_counsel (17.4); got ${instructions}`);
      const rec = rt.store.put("counterparty_notifications", id, { batch_id: str(i, "batch_id"), loan_id: str(i, "loan_id") || (prev?.loan_id as string | null | undefined) || null, party_type: pt, party_id: str(i, "party_id"), kind: str(i, "kind") || (prev?.kind as string | undefined) || notificationKind(pt), due_at: str(i, "due_at") || (prev?.due_at as string | undefined) || null, sent_at: today(ctx), channel: str(i, "channel") || "integration_messages", document_id: str(i, "document_id") || null, status: "sent" }, ctx.actor, ctx.now);
      ctx.events.append({ type: "counterparty_notification.sent", aggregate: agg, actor: ctx.actor, payload: { party_type: pt, party_id: str(i, "party_id"), kind: rec.data.kind, group, ...(instructions ? { counsel_instruction: instructions } : {}) } });
      const planned = counterpartyPlanned(rt, str(i, "batch_id"));
      const st = counterpartyStatus({ transfer_date: T, notifications: counterpartyRows(rt, str(i, "batch_id")) });
      // completeness is asserted only against a planned population: without a plan the first notice would "complete" its group
      if (planned && st.groups_complete.includes(group)) ctx.events.append({ type: "transfer.counterparty_notices.sent", aggregate: agg, actor: ctx.actor, payload: { group, batch_id: str(i, "batch_id") } });
      if (planned && st.event) ctx.events.append({ type: st.event.type, aggregate: agg, actor: ctx.actor, payload: { all_due_before_transfer_sent: true, batch_id: str(i, "batch_id") } });
      return { ...rec.data, group, ...(instructions ? { counsel_instruction: instructions } : {}), planned, group_complete: planned && st.groups_complete.includes(group), all_due_before_transfer_sent: planned && st.all_due_before_transfer_sent, unsent_due_before_transfer: st.unsent_due_before_transfer.map((n) => n.party_id) }; }) },
  { name: "verifyMersSnapshot", kind: "act", guardrails: [partnerCredentials], handler: compute((i, ctx, rt) => { const T = date(i, "transfer_date");
      if (i.op === "prepare" || i.op === "submit") {   // the partner's MIN Update / TOS file: Supermortgage prepares, the partner's officer / fnma_portal_operator submits
        need(i, "type", "mins"); const file = minUpdateFile({ type: str(i, "type") as TransferType, mins: list(i, "mins"), new_subservicer_org_id: str(i, "new_subservicer_org_id") || null });
        if (i.op === "submit") { need(i, "batch_id"); const rows = outboundMersAckRows({ type: str(i, "type") as TransferType, transfer_date: T, partner_org_id: str(i, "partner_org_id") || "partner", mins: list(i, "mins") });
          if (!rows.txn_type) throw new RangeError(`a ${str(i, "type")} batch has no MERS transaction to submit`);
          // one mers_transactions row per MIN (0019 DDL; 1.5 vocabulary): the partner's submission under its Org ID — the post-transfer snapshot is verified against these MINs
          for (const m of rows.rows) rt.store.put("mers_transactions", `${str(i, "batch_id")}-${m.min}`, { batch_id: str(i, "batch_id"), loan_id: m.loan_id, min: m.min, txn_type: m.txn_type, effective_date: m.effective_date, submitted_at: ctx.now, submitted_by_org_id: m.submitted_by_org_id, channel: "flat_file", status: "submitted" }, ctx.actor, ctx.now);
          ctx.events.append({ type: "mers.txn.submitted", aggregate: batchAgg(i), actor: ctx.actor, payload: { batch_id: str(i, "batch_id"), txn_type: rows.txn_type, transaction: file.transaction, mins: rows.rows.length, submitted_by: "partner", effective_date: T } }); }
        return file; }
      if (i.op === "ack") {   // the acknowledgment file: per-MIN accepted/rejected, the batch-level all_mins acceptance (MERS_PROC_SUBSERVICER_MIN_UPDATE_T0) and, for a TOS, the pending status (MERS_PROC_TOS_INITIATE_T0)
        need(i, "batch_id", "type", "mins", "results"); const rows = outboundMersAckRows({ type: str(i, "type") as TransferType, transfer_date: T, partner_org_id: str(i, "partner_org_id") || "partner", mins: list(i, "mins") });
        if (!rows.txn_type) throw new RangeError(`a ${str(i, "type")} batch has no MERS transaction to acknowledge`);
        const results = list<{ min: string; accepted: boolean; reason?: string }>(i, "results"); const r = ingestMersAcknowledgement(results); const ackedOn = optDate(i, "acked_on") ?? today(ctx);
        // the 1.5 vocabulary (inbound.ts recordMersAcknowledgement) on the outbound batch subject: per-MIN accepted/rejected, then the batch-level all_mins acceptance once every planned MIN is in
        for (const x of results) { const row = rows.rows.find((m) => m.min === x.min); if (rt.store.get("mers_transactions", `${str(i, "batch_id")}-${x.min}`)) rt.store.put("mers_transactions", `${str(i, "batch_id")}-${x.min}`, { status: x.accepted ? "accepted" : "rejected", ...(x.accepted ? {} : { mers_reject_code: x.reason ?? "rejected" }) }, ctx.actor, ctx.now);
          ctx.events.append({ type: x.accepted ? "mers.txn.accepted" : "mers.txn.rejected", ...(row?.loan_id ? { loanId: row.loan_id } : {}), aggregate: { kind: "mers_txn", id: `${str(i, "batch_id")}:${x.min}` }, actor: ctx.actor, payload: { batch_id: str(i, "batch_id"), min: x.min, txn_type: rows.txn_type, effective_date: T, acked_at: ackedOn, ...(x.accepted ? {} : { reason: x.reason ?? "rejected" }) } }); }
        const accepted = new Set(results.filter((x) => x.accepted).map((x) => x.min)); const all = rows.rows.length > 0 && rows.rows.every((m) => accepted.has(m.min));
        if (all) ctx.events.append({ type: "mers.txn.accepted", aggregate: batchAgg(i), actor: ctx.actor, payload: { batch_id: str(i, "batch_id"), txn_type: rows.txn_type, all_mins: true, accepted: r.accepted, rejected: r.rejected, acked_at: ackedOn } });
        if (rows.tos && all) ctx.events.append({ type: "mers.tos.pending_received", aggregate: batchAgg(i), actor: ctx.actor, payload: { batch_id: str(i, "batch_id"), txn_type: "tos_initiate", all_mins: true, initiated_by: "partner", effective_date: T } });
        return { txn_type: rows.txn_type, accepted: r.accepted, rejected: r.rejected, accepted_pct: r.accepted_pct, all_mins: all, exceptions: r.exceptions }; }
      // SM_MERS_POST_TRANSFER_VERIFY_3 (T+3 servicer BD): the snapshot is verified against the batch's MIN population (the partner's submitted mers_transactions rows, or the caller's list) —
      // a MIN missing from the snapshot, or one still carrying Supermortgage's Org ID in the Subservicer field, means no `mers.snapshot.verified{all_mins=true}` and a partner escalation
      need(i, "batch_id", "snapshot_on", "snapshot"); const mins = batchMins(rt, i); if (!mins.length) throw new RangeError("no MINs to verify: submit the partner's MERS transactions (op=submit) or pass mins");
      const v = verifyMersSnapshot({ transfer_date: T, snapshot_on: date(i, "snapshot_on"), mins, snapshot: list(i, "snapshot") });
      if (v.event) ctx.events.append({ type: v.event, aggregate: batchAgg(i), actor: ctx.actor, payload: { batch_id: str(i, "batch_id"), verify_by: v.verify_by, on_time: v.on_time, snapshot_on: str(i, "snapshot_on"), mins: v.expected, all_mins: v.ok } });
      else rt.escalations.open({ kind: "officer", batchId: str(i, "batch_id"), severity: "sev2", payload: { to: "partner", reason: `${v.remaining_with_supermortgage.length} MIN(s) still show Supermortgage in the Subservicer field and ${v.missing_from_snapshot.length} of ${v.expected} MIN(s) are missing from the ${str(i, "snapshot_on")} snapshot (verify by ${v.verify_by})`, remaining_with_supermortgage: v.remaining_with_supermortgage, missing_from_snapshot: v.missing_from_snapshot } }, ctx.actor);
      return v; }) },
  { name: "verifyERegistry", kind: "act", handler: compute((i, ctx, rt) => { need(i, "loan_id", "transfer_date", "servicing_agent_org_id", "transferee_org_id");
      const r = enoteServicingAgentHandoff({ transfer_date: date(i, "transfer_date"), servicing_agent_org_id: str(i, "servicing_agent_org_id"), transferee_org_id: str(i, "transferee_org_id"), checked_on: optDate(i, "checked_on") ?? today(ctx) });
      const ev = enoteHandoffEvidence({ updated: r.updated, edelivery_copies_acked: flag(i, "edelivery_copies_acked"), audit_trails_acked: flag(i, "audit_trails_acked") });
      if (ev.complete) ctx.events.append({ type: "enote.eregistry.updated", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { servicing_agent: "transferee", org_id: str(i, "transferee_org_id"), edelivery_copies_acked: true, audit_trails_acked: true, checked_on: optDate(i, "checked_on") ?? today(ctx) } });
      if (r.escalation) rt.escalations.open({ kind: "officer", loanId: str(i, "loan_id"), severity: r.escalation.severity ?? "sev2", payload: { to: r.escalation.to ?? null, reason: r.escalation.reason, timer: r.timer } }, ctx.actor);
      return { ...r, evidence: ev }; }) },
  { name: "buildDebrief", kind: "write", handler: compute((i, ctx, rt) => { need(i, "batch_id"); const T = date(i, "transfer_date");
      if (i.op === "archive") {   // security-records: `transfer_out_archives` for every loan within 10 servicer BD of the D31 ack
        need(i, "d31_acked_on", "listed_loans"); const plan = retentionPlan({ transfer_date: T, legal_hold_until: optDate(i, "legal_hold_until"), state_retention_years: Number.isNaN(num(i, "state_retention_years")) ? null : num(i, "state_retention_years") });
        for (const a of list<{ loan_id: string; archive_manifest_document_id: string | null }>(i, "archives")) rt.store.put("transfer_out_archives", a.loan_id, { loan_id: a.loan_id, batch_id: str(i, "batch_id"), archive_manifest_document_id: a.archive_manifest_document_id, retention: plan.retention_class, retain_until: plan.retain_until, legal_hold: plan.legal_hold, deidentified_at: null }, ctx.actor, ctx.now);
        const archives = rt.store.list("transfer_out_archives", (d) => d.batch_id === str(i, "batch_id")).map((r) => ({ loan_id: String(r.data.loan_id), archive_manifest_document_id: (r.data.archive_manifest_document_id as string | null) ?? null }));
        const s = archiveManifestStatus({ d31_acked_on: date(i, "d31_acked_on"), listed_loans: list<string>(i, "listed_loans"), archives });
        if (s.event) ctx.events.append({ type: s.event.type, aggregate: batchAgg(i), actor: ctx.actor, payload: { batch_id: str(i, "batch_id"), all_loans: true, loans: list<string>(i, "listed_loans").length, retain_until: plan.retain_until } });
        return { ...s, retain_until: plan.retain_until, retention_class: plan.retention_class }; }
      if (i.op === "deidentify") {   // after retain_until (no legal hold): PII de-identified per 19.1, manifest hashes kept
        need(i, "loan_id", "retain_until"); const d = deidentify({ retain_until: date(i, "retain_until"), legal_hold: flag(i, "legal_hold"), today: optDate(i, "today") ?? today(ctx), manifest: list(i, "manifest"), pii_fields: list<string>(i, "pii_fields") });
        if (d.ran) { rt.store.put("transfer_out_archives", str(i, "loan_id"), { loan_id: str(i, "loan_id"), batch_id: str(i, "batch_id"), deidentified_at: d.deidentified_at }, ctx.actor, ctx.now); ctx.events.append({ type: "transfer.archive.deidentified", loanId: str(i, "loan_id"), aggregate: batchAgg(i), actor: ctx.actor, payload: { loan_id: str(i, "loan_id"), deidentified_at: d.deidentified_at, pii_removed: [...d.pii_removed], manifest_hashes: d.manifest.map((m) => m.sha256) } }); }
        return d; }
      const d = buildDebrief({ transfer_date: T, deliverables: list(i, "deliverables"), transferee_requests: list(i, "transferee_requests"), misdirected_count: Number.isNaN(num(i, "misdirected_count")) ? 0 : num(i, "misdirected_count"), counterparty_notifications: list(i, "counterparty_notifications") });
      ctx.events.append({ type: d.event, aggregate: batchAgg(i), actor: ctx.actor, payload: { late_deliverables: d.late_deliverables, open_exceptions: d.open_exceptions, late_requests: d.late_requests, misdirected_payments: d.misdirected_payments, unacked_counterparties: d.unacked_counterparties } }); return d; }) },
  { name: "writeDecision", kind: "write", handler: decision() },
]);

/** The custodian feed (transferor custodian and transferee custodian): acknowledgments, manifests, Form 2009s and exception notices → the `custody.*` events the custody timers key on. */
function custodianFeed(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  need(i, "batch_id", "item"); const item = obj(i, "item"); const agg = batchAgg(i); const on = typeof item.on === "string" ? D(item.on) : today(ctx);
  const at = (type: string, payload: Record<string, unknown>): DomainEvent => ctx.events.append({ type, aggregate: agg, actor: ctx.actor, payload: { batch_id: str(i, "batch_id"), ...payload } });
  switch (String(item.kind ?? "")) {
    case "transferor_notice_confirmed": {   // FNMA_A2_7_03_TRANSFEROR_CUSTODIAN_NOTICE_30: the custodian's ack of the D-Code, Form 629 approval letter and final trial balance (Document Transfers Job Aid v5)
      const missing = ["d_code", "approval_letter_document_id", "trial_balance_document_id"].filter((k) => !item[k]); if (missing.length) throw new RangeError(`custodian notice confirmation carries ${missing.join(", ")}`);
      return at("custody.transferor_notice.confirmed", { confirmed_at: on, d_code: item.d_code, approval_letter_document_id: item.approval_letter_document_id, trial_balance_document_id: item.trial_balance_document_id }); }
    case "shipment_confirmed": {   // FNMA_DTJA_DOCS_SHIPPED_30 (and the participation notes): manifest + transferee custodian receipt
      if (!item.manifest_id || !item.transferee_custodian_receipt_id) throw new RangeError("shipment confirmation carries the manifest id and the transferee custodian receipt id");
      return at("custody.shipment.confirmed", { confirmed_at: on, manifest_id: item.manifest_id, transferee_custodian_receipt_id: item.transferee_custodian_receipt_id, document_count: Number(item.document_count ?? 0), participation_notes: item.participation_notes === true }); }
    case "form2009_handed_off": {   // SM_XFER_OUT_FORM2009_HANDOFF_T0: executed Form 2009s for open non-liquidation releases to the transferee custodian by T; unsigned ones are the signing officer's (flag execute + instrument form2009)
      need(i, "transfer_date"); const releases = list<{ loan_id: string; opened_on: PlainDate; liquidation: boolean; executed_form2009_document_id: string | null }>(i, "releases");
      const executing = flag(i, "execute") && INSTRUMENT.test(str(i, "instrument")) && typeof item.executed_document_id === "string";
      const h = form2009Handoff({ transfer_date: date(i, "transfer_date"), releases: releases.map((r) => (executing && !r.executed_form2009_document_id && !r.liquidation ? { ...r, executed_form2009_document_id: String(item.executed_document_id) } : r)), delivered_on: on });
      if (h.signing_officer_required.length) { rt.escalations.open({ kind: "signing_officer", batchId: str(i, "batch_id"), payload: { reason: `Form 2009 execution for ${h.signing_officer_required.join(", ")} before the ${h.due} hand-off`, instrument: "form2009" } }, ctx.actor); return h; }
      if (h.event) at(h.event, { recipient: h.recipient, delivered_at: on, loans: h.items.map((x) => x.loan_id), executed_by: executing ? ctx.actor.id : null });
      return h; }
    case "exception_received": {   // SM_XFER_OUT_RECERT_EXCEPTION_RESPONSE_10: the transferee custodian's recertification exception notice (+10 servicer BD)
      const exceptions = Array.isArray(item.exceptions) ? (item.exceptions as unknown[]) : []; if (!exceptions.length) throw new RangeError("exception notice lists the exceptions");
      return at("custody.transferee_exception.received", { received_at: on, exceptions, exception_count: exceptions.length }); }
    case "exception_resolved": {   // cured (allonge/assignment executed by the signing officer — flag execute + instrument) or documented
      const outcome = String(item.outcome ?? ""); if (outcome !== "cured" && outcome !== "documented") throw new RangeError("exception resolution outcome is cured or documented");
      return at("custody.transferee_exception.resolved", { resolved_at: on, outcome, instrument: str(i, "instrument") || null, executed_by: flag(i, "execute") ? ctx.actor.id : null, document_id: item.document_id ?? null }); }
    default: throw new RangeError(`custodian feed item kind ${String(item.kind ?? "")} is not one of transferor_notice_confirmed / shipment_confirmed / form2009_handed_off / exception_received / exception_resolved`);
  }
}
/** Loan balances from the bus (strings or bigints) as `LoanBalances`. */
function balances(l: Record<string, unknown>): LoanBalances {
  return { upb_cents: cents(l.upb_cents), escrow_cents: cents(l.escrow_cents), unapplied_cents: cents(l.unapplied_cents), corporate_advances_cents: cents(l.corporate_advances_cents), late_charges_cents: cents(l.late_charges_cents),
    ...(l.unremitted_pi_cents != null ? { unremitted_pi_cents: cents(l.unremitted_pi_cents) } : {}), ...(l.prepaid_next_period_pi_cents != null ? { prepaid_next_period_pi_cents: cents(l.prepaid_next_period_pi_cents) } : {}), ...(l.pi_advances_cents != null ? { pi_advances_cents: cents(l.pi_advances_cents) } : {}),
    ...(typeof l.escrow_interest_rate_pct === "string" ? { escrow_interest_rate_pct: l.escrow_interest_rate_pct } : {}) };
}

// read-only companions kept off the bus (not spec tool strings): the deliverable ledger is readable through the ops console.
export const readDeliverables = read("transfer_out_deliverables");
