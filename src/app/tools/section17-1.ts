/**
 * §17.1 tools — Fannie Mae transfer approval (`transfer` agent). Every tool
 * string is the spec's verbatim: buildTransferPlan, buildForm629,
 * buildCustodianMatrix, validateLoanList, reconcileQxDownload, createPortalTask,
 * parseApprovalLetter, computeDeadlines, draftFnmaResponse, draftForm101Termination,
 * writeDecision, notifyPartner. The transfer-out state machine rides on them
 * through `op`: buildTransferPlan {record_notice | propose | plan | milestone |
 * respa_exclusion}, createPortalTask {open | complete}, validateLoanList
 * {validate | submit_version | withdraw}, draftForm101Termination {draft | submit |
 * revoke_access | form582_reflected}; the officer acts the spec names (plan
 * approval, attestation, acceptance of conditions, the §1024.33(b)(2)(i)(C)
 * exclusion, any Fannie Mae correspondence, Form 101 termination) are flags the
 * handler executes and the guardrails gate.
 *
 * Status is measured, not remembered: a batch is always loaded from the store
 * (a caller-supplied `batch` is refused), the CD25 attestation a milestone
 * consumes is the record reconcileQxDownload wrote, the goodbye-run status is
 * 17.2's run record or the officer's recorded exclusion, and
 * `last_batch_for_partner` is recomputed from the partner's batches at every
 * transition. Guardrails encode the spec's "may not" / "never" / "only `officer`"
 * sentences: the transfer date must be the first Fannie Mae business day
 * (FNMA_A2_7_03_TRANSFER_DATE_GATE rejects `proposeBatch`); nothing may be added
 * after CD10; attestation needs zero CD20 differences and the partner `officer`;
 * the officer confirms before `approved`; termination fees are recorded, never
 * computed; Supermortgage may not stop servicing before the approved transfer
 * date; `attorney` only when Fannie Mae terminates for cause and the partner
 * requests counsel review; no borrower contact in 17.1.
 */
import { defineTools, compute, decision, never, needsRole, str, num, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { EscalationKind } from "../escalations.ts";
import type { TransferType } from "../../domain/transfers/batch.ts";
import { transferDateGate } from "../../domain/transfers/batch.ts";
import { respaEffectiveDate } from "../../domain/transfers/respa.ts";
import type { LoanListVersion } from "../../domain/transfers/inbound.ts";
import { transferPlan, approvePlan, form629Package, custodianMatrixSelection, validateLoanList, submitLoanListVersion, reconcileQxDownload, attestationGate, qxDifferenceResolution, attestLoanList, parseApprovalLetter, applyFnmaOutcome, computeDeadlines, fnmaResponseDraft, sendFnmaCorrespondence, form101TerminationDraft, submitForm101Termination, partnerAccessRevocation, partnerNotification, decisionRecord, proposeBatch, transitionTransferOut, recordNotice, counselReviewAllowed, fnmaProcessingConfirmation, quickExchangeCadenceOut, goodbyeRunForBatch, payoffAfterAttestation, form629PortalTaskOpened, form582TerminationReflected, type Form582FilingRecord, type TerminationBasis, type Form629Row, type TransferOutBatch, type TransferOutStatus, type TransitionEvidence, type FnmaInstruction, type NoticeKind, type OutEvent, type QxStatus } from "../../domain/transfers/ops-17-1.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const list = <T,>(i: ToolInput, k: string): readonly T[] => (Array.isArray(i[k]) ? (i[k] as T[]) : []);
const strings = (i: ToolInput, k: string): string[] => list<unknown>(i, k).map((x) => String(x));
const today = (i: ToolInput, ctx: CommandContext, k = "on"): PlainDate => optDate(i, k) ?? D(ctx.now.slice(0, 10));
const AGENT = "transfer";
const OFFICER = ["officer"] as const;
const BATCHES = "transfer_batches";
const LIST_VERSIONS = "transfer_batch_loan_list_versions";
const BATCH_LOANS = "transfer_batch_loans";
const OPEN_STATES = new Set(["closed", "denied", "withdrawn"]);
const op = (i: ToolInput, dflt: string): string => str(i, "op") || dflt;
const evidence = (i: ToolInput): Record<string, unknown> => (i.evidence as Record<string, unknown> | undefined) ?? {};
const instructionOf = (i: ToolInput): FnmaInstruction | null => { const f = i.fnma_instruction as Record<string, unknown> | undefined; if (f && typeof f.received_on === "string") return { received_on: D(f.received_on), transfer_date: typeof f.transfer_date === "string" ? D(f.transfer_date) : null, form629_by: typeof f.form629_by === "string" ? D(f.form629_by) : null, loan_list_by: typeof f.loan_list_by === "string" ? D(f.loan_list_by) : null, for_cause: f.for_cause === true }; const d = optDate(i, "fnma_instruction_date"); return d ? { received_on: d } : null; };
/** Append the domain's events on the batch aggregate (or the aggregate the event names). */
const emitAll = (ctx: CommandContext, batchId: string, events: readonly OutEvent[]): void => { for (const e of events) ctx.events.append({ type: e.type, aggregate: e.aggregate ?? { kind: "transfer_batch", id: batchId }, actor: ctx.actor, payload: e.payload }); };
/** The batch is the store's row and nothing else (a caller-supplied `batch` is refused by BATCH_STATE_IS_THE_STORE). */
const loadBatch = (i: ToolInput, rt: ToolRuntime): TransferOutBatch => { need(i, "batch_id"); const rec = rt.store.get(BATCHES, str(i, "batch_id")); if (!rec || rec.data.case_type !== "transfer_out") throw new RangeError(`no transfer_out batch ${str(i, "batch_id")}: propose it first`); return rec.data as unknown as TransferOutBatch; };
const saveBatch = (rt: ToolRuntime, b: TransferOutBatch, ctx: CommandContext): void => { rt.store.put(BATCHES, b.batch_id, { ...b }, ctx.actor, ctx.now); };
/** Milestone evidence: the facts the state machine must not take from the caller — the attestation, the goodbye-run status, the partner's batches — are dropped here and re-derived from the store. */
const evidenceOf = (i: ToolInput, ctx: CommandContext): TransitionEvidence => { const { attested_version: _a, goodbye_run_status: _g, partner_batches: _p, ...ev } = evidence(i); return { ...(ev as TransitionEvidence), actor: ctx.actor, ...(typeof ev.new_transfer_date === "string" ? { new_transfer_date: D(ev.new_transfer_date) } : {}), ...(typeof ev.partner_next_form582_due_on === "string" ? { partner_next_form582_due_on: D(ev.partner_next_form582_due_on) } : {}) }; };
const versionsOf = (rt: ToolRuntime, batchId: string, where: (d: Record<string, unknown>) => boolean = () => true): LoanListVersion[] => rt.store.list(LIST_VERSIONS, (d) => d.batch_id === batchId && where(d)).map((r) => r.data as unknown as LoanListVersion).sort((a, b) => b.version - a.version);
/** The attested list version reconcileQxDownload recorded (the partner officer's "Agree") — the only attestation a milestone accepts. */
const storedAttestation = (rt: ToolRuntime, batchId: string): LoanListVersion | null => versionsOf(rt, batchId, (d) => d.attested === true)[0] ?? null;
/** The goodbye run as 17.2 records it (transfer_notice_runs `run-<batch>-goodbye|combined`, status `complete` when mailed) or the §1024.33(b)(2)(i)(C) exclusion the officer recorded (this file's respa_exclusion op, or 17.2's transfer_notice_exclusions). */
const goodbyeRunStatus = (rt: ToolRuntime, b: TransferOutBatch): "planned" | "complete" | "excluded" | null => {
  const own = rt.store.get(BATCHES, b.batch_id)?.data.goodbye_run_status;
  if (own === "excluded" || rt.store.get("transfer_notice_exclusions", `excl-${b.batch_id}`)) return "excluded";
  const run = rt.store.get("transfer_notice_runs", `run-${b.batch_id}-goodbye`) ?? rt.store.get("transfer_notice_runs", `run-${b.batch_id}-combined`);
  if (run) return run.data.status === "complete" ? "complete" : "planned";
  return own === "planned" ? "planned" : null;
};
/** Every transfer_out batch of the partner, so `last_batch_for_partner` is measured at the transition. */
const partnerBatches = (rt: ToolRuntime, b: TransferOutBatch): { batch_id: string; status: string }[] | null => (b.partner_id ? rt.store.list(BATCHES, (d) => d.case_type === "transfer_out" && d.partner_id === b.partner_id).map((r) => ({ batch_id: String(r.data.batch_id), status: String(r.data.status) })) : null);
/** Loans already on another open transfer-out batch (its latest list version): "the platform prevents a loan from being on two open batches". */
const openBatchLoans = (rt: ToolRuntime, batchId: string): Map<string, string> => { const m = new Map<string, string>(); for (const b of rt.store.list(BATCHES, (d) => d.case_type === "transfer_out" && d.batch_id !== batchId && !OPEN_STATES.has(String(d.status)))) for (const n of versionsOf(rt, b.id)[0]?.loans ?? []) if (!m.has(n)) m.set(n, b.id); return m; };
const filingOf = (f: Record<string, unknown>): Form582FilingRecord => ({ form: f.form as "form_582", filing_id: String(f.filing_id ?? ""), entity: f.entity as "partner", period_end: String(f.period_end ?? "") as PlainDate, submitted_on: String(f.submitted_on ?? "") as PlainDate, ecrm_confirmation_document_id: String(f.ecrm_confirmation_document_id ?? ""), subservicing_arrangements: (Array.isArray(f.subservicing_arrangements) ? f.subservicing_arrangements : []) as Form582FilingRecord["subservicing_arrangements"], approved_by_officer_id: (f.approved_by_officer_id as string | undefined) ?? null });
/** Adds a `submit_version` would make against the previous version — the CD10 rule's subject. */
const addsIn = (i: ToolInput): string[] => { const prev = new Set(((i.previous as LoanListVersion | undefined)?.loans ?? []) as string[]); return list<unknown>(i, "loans").map((l) => (typeof l === "string" ? l : String((l as Record<string, unknown>).fnma_loan_number ?? ""))).filter((n) => !prev.has(n)); };
const isAfterCd10 = (i: ToolInput): boolean => op(i, "validate") === "submit_version" && !!str(i, "transfer_date") && !!str(i, "submitted_on") && addsIn(i).length > 0 && D(str(i, "submitted_on")) > quickExchangeCadenceOut(D(str(i, "transfer_date"))).adds_by;
const milestoneTo = (i: ToolInput, ...to: string[]): boolean => op(i, "plan") === "milestone" && to.includes(str(i, "to"));
const noFeeComputation = never("NO_TERMINATION_FEE_COMPUTATION", "17.1 rule: termination-fee facts (A1-2-02) are recorded, never computed by the platform — a partner/counsel matter", (i) => flag(i, "compute_termination_fee") || str(i, "action") === "compute_termination_fee", "record the fee facts the partner supplies; the platform supplies UPB, delinquency status and servicing-fee data only");
const storeIsTheBatch = never("BATCH_STATE_IS_THE_STORE", "17.1 state machine guards (`approved` requires the approval-letter hash; `loan_list_frozen` the attestation evidence; `cutover` the 17.2 goodbye run `complete` and the 17.3 preliminary tape) hold only against the stored batch — status is measured, not remembered", (i) => i.batch !== undefined, "name the batch_id; the store holds its state");

export const TOOLS_17_1: readonly ToolDef[] = defineTools("17.1", AGENT, [
  { name: "buildTransferPlan", kind: "act", handler: compute((i, ctx, rt) => {
      switch (op(i, "plan")) {
        case "record_notice": {   // inputs (a)/(b)/(c): the notice that opens a transfer-out, or a partner duty the platform monitors
          need(i, "partner_id", "kind", "notice_on");
          const r = recordNotice({ partner_id: str(i, "partner_id"), kind: str(i, "kind") as NoticeKind, notice_on: date(i, "notice_on"), document_id: (i.document_id as string | undefined) ?? null, counsel_review_requested_by_partner: flag(i, "counsel_review_requested_by_partner"), batch_id: (i.batch_id as string | undefined) ?? null, ...(Number.isFinite(num(i, "loan_count")) ? { loan_count: num(i, "loan_count") } : {}) });
          emitAll(ctx, str(i, "partner_id"), r.events);
          const tasks = r.tasks.map((t) => { const e = rt.escalations.open({ kind: t.kind, ownerRole: t.owner_role, payload: { task: t.task, partner_id: str(i, "partner_id"), due: t.due, notice_on: str(i, "notice_on"), termination_fee: r.termination_fee } }, ctx.actor); return { escalation_id: e.id, kind: e.kind, owner_role: e.ownerRole, task: t.task, due: t.due }; });
          return { ...r, tasks };
        }
        case "propose": {   // `proposeBatch`: FNMA_A2_7_03_TRANSFER_DATE_GATE asserted here (T2)
          need(i, "batch_id", "transfer_type", "transfer_date", "source");
          const r = proposeBatch({ batch_id: str(i, "batch_id"), partner_id: (i.partner_id as string | undefined) ?? null, transfer_type: str(i, "transfer_type") as TransferType, transfer_date: date(i, "transfer_date"), sale_date: optDate(i, "sale_date"), termination_basis: (i.termination_basis as TerminationBasis | undefined) ?? null, transferee_servicer_number: (i.transferee_servicer_number as string | undefined) ?? null,
            loan_count: Number.isFinite(num(i, "loan_count")) ? num(i, "loan_count") : 0, first_batch_for_partner: flag(i, "first_batch_for_partner"), last_batch_for_partner: flag(i, "last_batch_for_partner"), supermortgage_is_tech_provider: flag(i, "supermortgage_is_tech_provider"), fnma_instruction: instructionOf(i), source: str(i, "source") as "partner_instruction" | "fnma_termination_notice" | "supermortgage_exit", proposed_on: optDate(i, "proposed_on") ?? today(i, ctx) });
          saveBatch(rt, r.batch, ctx); emitAll(ctx, r.batch.batch_id, r.events);
          return { batch: r.batch, deadlines: computeDeadlines({ transfer_type: r.batch.transfer_type, transfer_date: r.batch.transfer_date, sale_date: r.batch.sale_date, termination_basis: r.batch.termination_basis, last_batch_for_partner: r.batch.last_batch_for_partner, loan_count: r.batch.loan_count, supermortgage_is_tech_provider: r.batch.supermortgage_is_tech_provider, fnma_instruction: r.batch.fnma_instruction }).rows };
        }
        case "milestone": {   // Bulletin 2020-02 milestones: every post-proposal transition of the transfer-out state machine with its evidence guard, the evidence read from the store
          need(i, "to"); const b = loadBatch(i, rt); const to = str(i, "to") as TransferOutStatus;
          const attested = to === "loan_list_frozen" ? storedAttestation(rt, b.batch_id) : null;
          const goodbye = to === "notice_window" || to === "cutover" ? goodbyeRunStatus(rt, b) : null;
          const pb = partnerBatches(rt, b);
          const t = transitionTransferOut(b, to, { ...evidenceOf(i, ctx), ...(attested ? { attested_version: attested } : {}), ...(goodbye ? { goodbye_run_status: goodbye } : {}), ...(pb ? { partner_batches: pb } : {}) }, today(i, ctx));
          // 32.12 backend delta (additive): the approval carries the 1.3 / 17.2 notice facts the registry's goodbye and combined clocks key on — `notice_mode` (separate | combined) and `respa_effective_date` (= transfer_date unless the first installment due to the transferee differs; respa.ts respaEffectiveDate) — so REGX_1024_33B3_GOODBYE_15 / COMBINED_15 arm on `transfer.batch.approved{direction=out, notice_mode}` with their anchor
          const noticeMode = str(i, "notice_mode") === "combined" ? "combined" : "separate";
          const respaEffective = optDate(i, "respa_effective_date") ?? respaEffectiveDate(b.transfer_date, i.installments_due_on_1st !== false);
          const withNotice = t.events.map((e) => (e.type === "transfer.batch.approved" ? { ...e, payload: { notice_mode: noticeMode, respa_effective_date: respaEffective, ...e.payload } } : e));
          saveBatch(rt, { ...t.batch, ...(to === "approved" ? { notice_mode: noticeMode, respa_effective_date: respaEffective } : {}) } as TransferOutBatch, ctx); emitAll(ctx, b.batch_id, withNotice);
          return { batch: t.batch, events: t.events.map((e) => e.type) };
        }
        case "respa_exclusion": {   // rule 17.1: `master_change_sub_retained` with payee/address/account/amount unchanged → no goodbye run; the `officer` sign-off records the exclusion (T5)
          const b = loadBatch(i, rt); const u = (i.unchanged as Record<string, unknown> | undefined) ?? {};
          const r = goodbyeRunForBatch({ transfer_type: b.transfer_type, transfer_date: b.transfer_date, sale_date: b.sale_date, unchanged: { payee: u.payee === true, address: u.address === true, account: u.account === true, amount: u.amount === true }, officer: ctx.actor });
          if (r.block) throw new RangeError(r.block);
          if (r.exclusion_record) {
            rt.store.put(BATCHES, b.batch_id, { goodbye_run_status: "excluded", respa_exclusion: { ...r.exclusion_record, recorded_on: today(i, ctx) } }, ctx.actor, ctx.now);
            ctx.events.append({ type: "transfer.respa_exclusion.recorded", aggregate: { kind: "transfer_batch", id: b.batch_id }, actor: ctx.actor, payload: { batch_id: b.batch_id, transfer_type: b.transfer_type, rule: r.exclusion_record.rule, basis: r.exclusion_record.basis, approved_by: r.exclusion_record.approved_by, unchanged: { payee: u.payee === true, address: u.address === true, account: u.account === true, amount: u.amount === true } } });
          } else {
            rt.store.put(BATCHES, b.batch_id, { goodbye_run_status: "planned" }, ctx.actor, ctx.now);
            ctx.events.append({ type: "transfer.goodbye_run.required", aggregate: { kind: "transfer_batch", id: b.batch_id }, actor: ctx.actor, payload: { batch_id: b.batch_id, transfer_type: b.transfer_type, process: "17.2" } });
          }
          return { ...r, batch_id: b.batch_id, goodbye_run_status: r.exclusion_record ? "excluded" : "planned" };
        }
        default: {
          need(i, "batch_id", "transfer_type", "transfer_date");
          const plan = transferPlan({ batch_id: str(i, "batch_id"), transfer_type: str(i, "transfer_type") as TransferType, transfer_date: date(i, "transfer_date"), sale_date: optDate(i, "sale_date"), elements: (i.elements as Record<string, string> | undefined) ?? {} });
          ctx.events.append({ type: plan.event, aggregate: { kind: "transfer_batch", id: plan.batch_id }, actor: ctx.actor, payload: { batch_id: plan.batch_id, approve_by: plan.approve_by, missing_elements: plan.missing_elements } });
          if (!flag(i, "approve")) return plan;
          const a = approvePlan(plan, ctx.actor);
          ctx.events.append({ type: a.event, aggregate: { kind: "transfer_batch", id: plan.batch_id }, actor: ctx.actor, payload: { batch_id: plan.batch_id, approved_by: a.approved_by } });
          const rec = rt.store.get(BATCHES, plan.batch_id);
          if (rec && rec.data.status === "proposed") { const t = transitionTransferOut(rec.data as unknown as TransferOutBatch, "plan_approved", { actor: ctx.actor }, today(i, ctx)); saveBatch(rt, t.batch, ctx); emitAll(ctx, plan.batch_id, t.events); }
          return { ...plan, ...a }; }
      } }),
    guardrails: [never("FNMA_A2_7_03_TRANSFER_DATE_GATE", "A2-7-03 / 17.1 timer table: `transfer_date` must equal the first `business_days_fannie_et` of the month — asserted in `proposeBatch`; command rejected", (i) => op(i, "plan") === "propose" && !!str(i, "transfer_date") && !transferDateGate(D(str(i, "transfer_date"))).ok && !(str(i, "transfer_type") === "fnma_directed" && instructionOf(i) !== null), "re-base the transfer date to the first Fannie Mae business day of the month"),
      needsRole("PLAN_APPROVAL_IS_OFFICER", "17.1 escalations: `officer` (partner) approves the Bulletin 2020-02 transfer plan", (i) => flag(i, "approve") || milestoneTo(i, "plan_approved"), OFFICER, "the agent prepares the plan; the partner officer approves it"),
      needsRole("APPROVAL_CONFIRMED_BY_OFFICER", "17.1 state machine: `approved` (approval letter + D-Code hashed; `officer` confirms conditions) — integrations: the approval letter is parsed for D-Code, conditions and loan count; `officer` confirms before `approved`", (i) => milestoneTo(i, "approved"), OFFICER, "parse the letter with parseApprovalLetter; the partner officer confirms the D-Code and accepts any conditions"),
      needsRole("RESPA_EXCLUSION_IS_OFFICER", "17.1 rule: no RESPA notice if payee, address, account number and payment amount are unchanged (§1024.33(b)(2)(i)(C)) — `officer` sign-off records the exclusion", (i) => op(i, "plan") === "respa_exclusion", OFFICER, "the agent proposes the exclusion; the partner officer signs it off"),
      storeIsTheBatch,
      never("ATTESTATION_EVIDENCE_IS_RECORDED", "17.1 state machine: `loan_list_frozen` requires the attestation evidence (CD25 Quick Exchange \"Agree\" by the partner officer) — the version reconcileQxDownload recorded, never a caller-supplied one", (i) => milestoneTo(i, "loan_list_frozen") && evidence(i).attested_version !== undefined, "attest through reconcileQxDownload{attest:true} as the partner officer"),
      never("GOODBYE_RUN_STATUS_IS_RECORDED", "17.1 state machine: `cutover` requires 17.2 goodbye run `complete` (or the §1024.33(b)(2)(i)(C) exclusion the officer recorded) — 17.2's run record, never a caller-supplied status", (i) => milestoneTo(i, "notice_window", "cutover") && evidence(i).goodbye_run_status !== undefined, "17.2 records the goodbye run; the officer records the exclusion with respa_exclusion"),
      never("NO_SERVICING_STOP_BEFORE_TRANSFER_DATE", "17.1 edge case: Supermortgage may not stop servicing before the approved transfer date (A2-7-03 unauthorized-transfer sanctions)", (i) => milestoneTo(i, "cutover") && (i.fnma_approved === false || (!!str(i, "on") && !!str(i, "transfer_date") && D(str(i, "on")) < D(str(i, "transfer_date")))), "servicing continues through the approved transfer date"),
      never("ATTORNEY_ONLY_FOR_CAUSE_ON_PARTNER_REQUEST", "17.1 escalations: `attorney` only when Fannie Mae terminates for cause and counsel review is requested by the partner", (i) => op(i, "plan") === "record_notice" && flag(i, "counsel_review_requested_by_partner") && !counselReviewAllowed(str(i, "kind") as NoticeKind, true), "route the question to the partner officer"),
      noFeeComputation] },
  { name: "buildForm629", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "batch_id", "transfer_type", "transfer_date", "rows");
      const rows = list<Record<string, unknown>>(i, "rows").map((r): Form629Row => ({ transferor_servicer_number: String(r.transferor_servicer_number ?? ""), transferee_servicer_number: String(r.transferee_servicer_number ?? ""), fnma_loan_number: String(r.fnma_loan_number ?? ""), upb_cents: typeof r.upb_cents === "bigint" ? r.upb_cents : BigInt(String(r.upb_cents ?? 0)), transferor_custodian: String(r.transferor_custodian ?? ""), transferee_custodian: String(r.transferee_custodian ?? ""), kind: r.kind === "acquired_property" ? "acquired_property" : "loan", special_notification: (r.special_notification as Form629Row["special_notification"]) ?? null }));
      const pkg = form629Package({ transfer_type: str(i, "transfer_type") as TransferType, transfer_date: date(i, "transfer_date"), sale_date: optDate(i, "sale_date"), rows, custodian_matrix: strings(i, "custodian_matrix"), transferee_uses_subservicer: flag(i, "transferee_uses_subservicer"), transferee_subservicer_number: (i.transferee_subservicer_number as string | undefined) ?? null, fnma_instruction: instructionOf(i) });
      if (!pkg.ok) return pkg;
      ctx.events.append({ type: pkg.event, aggregate: { kind: "transfer_batch", id: str(i, "batch_id") }, actor: ctx.actor, payload: { batch_id: str(i, "batch_id"), loan_rows: pkg.loan_rows, acquired_property_rows: pkg.acquired_property_rows, deadline: pkg.deadline, special_notifications: pkg.special_notifications.length } });
      const rec = rt.store.get(BATCHES, str(i, "batch_id"));
      if (rec && rec.data.status === "plan_approved" && i.evidence) { const t = transitionTransferOut(rec.data as unknown as TransferOutBatch, "package_ready", { ...evidenceOf(i, ctx), subservicer_answer_recorded: true, special_notifications_listed: true, loan_list_version: (evidenceOf(i, ctx).loan_list_version ?? 1) }, today(i, ctx)); saveBatch(rt, t.batch, ctx); emitAll(ctx, t.batch.batch_id, t.events); return { ...pkg, status: t.batch.status }; }
      return pkg; }),
    guardrails: [never("TRANSFER_DATE_FIRST_BUSINESS_DAY", "A2-7-03: the proposed transfer date must be the first business day of the month (FNMA_A2_7_03_TRANSFER_DATE_GATE)", (i) => !!str(i, "transfer_date") && !transferDateGate(D(str(i, "transfer_date"))).ok && instructionOf(i) === null, "re-base the transfer date to the first Fannie Mae business day"),
      never("PACKAGE_ONLY_NEVER_SUBMIT", "17.1 integrations: Quick Exchange is portal-only — the agent builds the package; a partner user or `fnma_portal_operator` submits it", (i) => flag(i, "submit"), "file a portal task instead")] },
  { name: "buildCustodianMatrix", kind: "read", handler: compute((i) => { need(i, "loans"); return custodianMatrixSelection({ loans: list<{ fnma_loan_number: string; enote: boolean; transferor_custodian: string; transferee_custodian: string }>(i, "loans"), matrix: strings(i, "matrix") }); }) },
  { name: "validateLoanList", kind: "act", handler: compute((i, ctx, rt) => {
      if (op(i, "validate") === "withdraw") {   // payoff/repurchase/foreclosure after the CD25 attestation (T8): flagged, the 5.3 removal report due by BD2 as an operator task, servicing_transfers@fanniemae.com informed, the final tape marks it
        const b = loadBatch(i, rt); need(i, "fnma_loan_number", "paid_off_on");
        const reason = str(i, "reason"); const w = payoffAfterAttestation({ fnma_loan_number: str(i, "fnma_loan_number"), paid_off_on: date(i, "paid_off_on"), attested_on: b.attested_at, transfer_date: b.transfer_date, ...(reason === "repurchased" || reason === "foreclosed" ? { reason } : { reason: "paid_off" as const }) });
        rt.store.put(BATCH_LOANS, `${b.batch_id}:${w.fnma_loan_number}`, { batch_id: b.batch_id, fnma_loan_number: w.fnma_loan_number, offboarding_status: w.offboarding_status, withdrawal_flag: w.flag, paid_off_on: w.event.payload.paid_off_on, removal_report_by: w.removal_report_by, transferee_tape_marker: w.transferee_tape_marker }, ctx.actor, ctx.now);
        emitAll(ctx, b.batch_id, [w.event]);
        const task = w.removal_task ? rt.escalations.open({ kind: w.removal_task.kind, batchId: b.batch_id, payload: { task: w.removal_task.task, batch_id: b.batch_id, fnma_loan_number: w.fnma_loan_number, due: w.removal_task.due, inform: w.removal_task.inform, report_via: w.report_via, fnma_processes_on: w.fnma_processes_on } }, ctx.actor) : null;
        return { ...w, removal_task_id: task?.id ?? null };
      }
      need(i, "loans", "transfer_date");
      const others = str(i, "batch_id") ? openBatchLoans(rt, str(i, "batch_id")) : new Map<string, string>();
      const validated = validateLoanList({ loans: list<Record<string, unknown>>(i, "loans").map((l) => { const n = typeof l === "string" ? l : String(l.fnma_loan_number ?? ""); return typeof l === "string" ? { fnma_loan_number: n, active: true, other_open_batch_id: others.get(n) ?? null } : { fnma_loan_number: n, active: l.active !== false, other_open_batch_id: (l.other_open_batch_id as string | undefined) ?? others.get(n) ?? null, added_on: typeof l.added_on === "string" ? D(l.added_on) : null }; }), transfer_date: date(i, "transfer_date"), package_date: optDate(i, "package_date") ?? today(i, ctx) });
      if (op(i, "validate") !== "submit_version") return validated;
      need(i, "batch_id", "submitted_on");
      if (!validated.ok) throw new RangeError(`loan list invalid: ${validated.errors.join("; ")}`);
      const v = submitLoanListVersion({ previous: (i.previous as LoanListVersion | undefined) ?? versionsOf(rt, str(i, "batch_id"))[0] ?? null, loans: validated.listed, submitted_on: date(i, "submitted_on"), transfer_date: date(i, "transfer_date"), reason: (i.reason as string | undefined) ?? null });
      rt.store.put(LIST_VERSIONS, `${str(i, "batch_id")}-v${v.version.version}`, { batch_id: str(i, "batch_id"), ...v.version }, ctx.actor, ctx.now);
      emitAll(ctx, str(i, "batch_id"), [v.event]);
      return { ...validated, version: v.version, adds: v.adds, deletes: v.deletes }; }),
    guardrails: [never("NOTHING_ADDED_AFTER_CD10", "17.1 rule: nothing may be added after CD10 (Quick Exchange loan additions by the 10th calendar day of the month prior)", isAfterCd10, "additions roll to a new batch/next month"), storeIsTheBatch] },
  { name: "reconcileQxDownload", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "batch_id", "download", "version");
      const version = i.version as LoanListVersion;
      const recon = reconcileQxDownload({ download: strings(i, "download"), version, downloaded_on: optDate(i, "downloaded_on") });
      const gate = attestationGate(recon, version);
      const on = today(i, ctx, "today");
      const resolution = str(i, "transfer_date") ? qxDifferenceResolution(recon, on, quickExchangeCadenceOut(D(str(i, "transfer_date"))).adds_by) : [];
      if (recon.event) ctx.events.append({ type: recon.event, aggregate: { kind: "transfer_batch", id: str(i, "batch_id") }, actor: ctx.actor, payload: { batch_id: str(i, "batch_id"), version: recon.version, zero_differences: true, downloaded_on: recon.downloaded_on } });
      if (!flag(i, "attest")) return { reconciliation: recon, attestation_gate: gate, resolution };
      const attested = attestLoanList(gate, version, ctx.actor, on);   // the partner officer's "Agree": transfer.loan_list.attested + finalized
      emitAll(ctx, str(i, "batch_id"), attested.events);
      rt.store.put(LIST_VERSIONS, `${str(i, "batch_id")}-v${attested.version}`, { batch_id: str(i, "batch_id"), ...attested, events: undefined, attested_on: on }, ctx.actor, ctx.now);
      const rec = rt.store.get(BATCHES, str(i, "batch_id"));
      if (rec && rec.data.status === "approved") { const t = transitionTransferOut(rec.data as unknown as TransferOutBatch, "loan_list_frozen", { actor: ctx.actor, attested_version: attested }, on); saveBatch(rt, t.batch, ctx); emitAll(ctx, t.batch.batch_id, t.events); }
      return { reconciliation: recon, attestation_gate: gate, resolution, attested: { version: attested.version, attested_by: attested.attested_by, attested_on: on }, events: attested.events.map((e) => e.type) }; }),
    guardrails: [never("ATTEST_NEEDS_ZERO_DIFFERENCES", "17.1 rule: the CD20 reconciliation must show zero differences before attestation", (i) => flag(i, "attest") && Array.isArray(i.download) && !!i.version && !reconcileQxDownload({ download: strings(i, "download"), version: i.version as LoanListVersion }).zero_differences, "resolve every difference in a new list version first"),
      needsRole("ATTESTATION_IS_OFFICER", "17.1 escalations: the partner `officer` authorizes \"Agree\" (attestation)", (i) => flag(i, "attest"), OFFICER, "the agent reconciles; the partner officer attests")] },
  { name: "createPortalTask", kind: "act", handler: compute((i, ctx, rt) => {
      if (op(i, "open") === "complete") {   // the operator's completion evidence: form629 → `transfer.form629.submitted` (+ batch `submitted`); connect_bd3 → `fnma.transfer.processed`
        need(i, "escalation_id", "task");
        const e = rt.escalations.complete(str(i, "escalation_id"), ctx.actor, (i.evidence_document_id as string | undefined) ?? undefined);
        const task = str(i, "task"), batchId = str(i, "batch_id");
        if (task === "form629") {
          need(i, "batch_id", "qx_request_id");
          ctx.events.append({ type: "transfer.form629.submitted", aggregate: { kind: "transfer_batch", id: batchId }, actor: ctx.actor, payload: { batch_id: batchId, qx_request_id: str(i, "qx_request_id"), portal_completion_record_id: e.id, evidence_document_id: e.evidenceDocumentId ?? null, submitted_on: today(i, ctx) } });
          const rec = rt.store.get(BATCHES, batchId);
          if (rec && (rec.data.status === "package_ready" || rec.data.status === "info_requested")) { const t = transitionTransferOut(rec.data as unknown as TransferOutBatch, "submitted", { actor: ctx.actor, portal_completion_record_id: e.id, qx_request_id: str(i, "qx_request_id"), ...(typeof i.qx_status === "string" ? { qx_status: i.qx_status as QxStatus } : {}) }, today(i, ctx)); saveBatch(rt, t.batch, ctx); emitAll(ctx, batchId, t.events); }
        }
        if (task === "connect_bd3") {
          need(i, "batch_id", "transfer_date", "transferee_servicer_number", "report_as_of");
          const c = fnmaProcessingConfirmation({ transfer_date: date(i, "transfer_date"), report_as_of: date(i, "report_as_of"), transferee_servicer_number: str(i, "transferee_servicer_number"), expected: strings(i, "expected"), rows: list<{ fnma_loan_number: string; servicer_number: string }>(i, "rows") });
          if (c.event) emitAll(ctx, batchId, [c.event]);
          return { escalation_id: e.id, status: e.status, task, confirmation: c };
        }
        return { escalation_id: e.id, status: e.status, task };
      }
      need(i, "batch_id", "task");
      const kind = (i.kind as EscalationKind | undefined) ?? "human_portal_task", batchId = str(i, "batch_id");
      const e = rt.escalations.open({ kind, batchId, payload: { task: str(i, "task"), batch_id: batchId, package: (i.package as Record<string, unknown> | undefined) ?? {}, expected_artifacts: list<string>(i, "expected_artifacts"), scheduled_on: (i.scheduled_on as string | undefined) ?? null }, ...(typeof i.owner_role === "string" ? { ownerRole: i.owner_role } : {}), ...(typeof i.severity === "string" ? { severity: i.severity } : {}) }, ctx.actor);
      // the service's `escalation.created{kind=human_portal_task, task=form629}` is what arms SM_PORTAL_TASK_FORM629_SLA_2 (the operator's `escalation.completed` satisfies it): read it back and project it onto the batch — portal_task_ids for the decision record, the SLA anchor and due date
      const created = ctx.events.ofType("escalation.created").find((x) => x.payload.escalation_id === e.id);
      const sla = created ? form629PortalTaskOpened(created) : null;
      const rec = rt.store.get(BATCHES, batchId);
      if (rec) rt.store.put(BATCHES, batchId, { portal_task_ids: [...((rec.data.portal_task_ids as string[] | undefined) ?? []), e.id], ...(sla ? { form629_portal_task_sla_due: sla.sla_due } : {}) }, ctx.actor, ctx.now);
      return { escalation_id: e.id, kind: e.kind, owner_role: e.ownerRole, task: str(i, "task"), sla: sla?.timer ?? null, sla_created_at: sla?.created_at ?? null, sla_due: sla?.sla_due ?? null }; }),
    guardrails: [never("PORTAL_TASK_ROUTING", "17.1 escalations: `fnma_portal_operator` (Quick Exchange, Connect downloads); `officer` (partner) for plan approval, attestation, acceptance of conditions, any Fannie Mae correspondence, Form 101 termination and termination-fee matters; `attorney` only when Fannie Mae terminates for cause", (i) => op(i, "open") === "open" && !!str(i, "kind") && !["human_portal_task", "officer", "attorney"].includes(str(i, "kind")), "17.1 opens portal-operator, officer or (for cause, on request) attorney tasks only"),
      never("ATTORNEY_ONLY_FOR_CAUSE_ON_PARTNER_REQUEST", "17.1 escalations: `attorney` only when Fannie Mae terminates for cause and counsel review is requested by the partner", (i) => op(i, "open") === "open" && (str(i, "kind") === "attorney" || str(i, "owner_role") === "attorney") && !counselReviewAllowed(str(i, "termination_basis") as TerminationBasis, flag(i, "counsel_review_requested_by_partner")), "route the question to the partner officer"),
      never("TERMINATION_FEE_MATTERS_TO_OFFICER", "17.1 escalations: `officer` (partner) for termination-fee matters — recorded, never computed", (i) => op(i, "open") === "open" && str(i, "task") === "termination_fee_facts" && (!!str(i, "kind") && str(i, "kind") !== "officer" || (!!str(i, "owner_role") && str(i, "owner_role") !== "officer")), "open the fee-facts task for the partner officer"),
      never("PORTAL_TASK_ONLY_QUICK_EXCHANGE", "17.1 integrations: Quick Exchange is portal-only; the agent never submits — the human_portal_task package is completed by the partner user or `fnma_portal_operator`", (i) => op(i, "open") === "open" && flag(i, "submit_for_operator"), "the operator completes the task with the request ID as evidence")] },
  { name: "parseApprovalLetter", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "batch_id", "text");
      const parsed = parseApprovalLetter(str(i, "text"));
      ctx.events.append({ type: parsed.next_status === "info_requested" ? "transfer.fnma_query.received" : "transfer.fnma_consent.received", aggregate: { kind: "transfer_batch", id: str(i, "batch_id") }, actor: ctx.actor, payload: { batch_id: str(i, "batch_id"), outcome: parsed.outcome, d_code: parsed.d_code, conditions: parsed.conditions, loan_count: parsed.loan_count, effective_date: parsed.effective_date } });
      if (!(flag(i, "mark_approved") || flag(i, "accept_conditions") || flag(i, "apply_outcome"))) return parsed;
      const b = loadBatch(i, rt);   // the officer confirms the D-Code / accepts conditions: `approved` (or denied / on_hold / info_requested per the letter)
      const r = applyFnmaOutcome(b, parsed, { actor: ctx.actor, on: today(i, ctx), approval_letter_document_hash: (i.approval_letter_document_hash as string | undefined) ?? null, partner_decision_id: (i.partner_decision_id as string | undefined) ?? null, new_transfer_date: optDate(i, "new_transfer_date"), conditions_accepted: flag(i, "accept_conditions") || (flag(i, "mark_approved") && parsed.conditions.length === 0) });
      saveBatch(rt, r.batch, ctx); emitAll(ctx, b.batch_id, r.events);
      return { ...parsed, status: r.batch.status, qx_status: r.batch.qx_status, events: r.events.map((e) => e.type) }; }),
    guardrails: [needsRole("CONDITIONS_ACCEPTED_BY_OFFICER", "17.1 integrations: the approval letter is parsed for D-Code, conditions and loan count; the `officer` confirms before `approved`", (i) => flag(i, "mark_approved") || flag(i, "accept_conditions"), OFFICER, "the agent parses; the partner officer confirms the D-Code and accepts conditions"), storeIsTheBatch] },
  { name: "computeDeadlines", kind: "read", handler: compute((i) => {
      need(i, "transfer_type", "transfer_date");
      return computeDeadlines({ transfer_type: str(i, "transfer_type") as TransferType, transfer_date: date(i, "transfer_date"), sale_date: optDate(i, "sale_date"), proposed_on: optDate(i, "proposed_on"), termination_basis: (i.termination_basis as TerminationBasis | undefined) ?? null, fnma_termination_notice_on: optDate(i, "fnma_termination_notice_on"), approval_on: optDate(i, "approval_on"), partner_termination_notice_on: optDate(i, "partner_termination_notice_on"), last_batch_for_partner: flag(i, "last_batch_for_partner"), loan_count: Number.isFinite(num(i, "loan_count")) ? num(i, "loan_count") : 0, supermortgage_is_tech_provider: flag(i, "supermortgage_is_tech_provider"), contract_termination_notice_on: optDate(i, "contract_termination_notice_on"), fnma_instruction: instructionOf(i) }); }),
    guardrails: [noFeeComputation] },
  { name: "draftFnmaResponse", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "batch_id", "query");
      const draft = fnmaResponseDraft({ batch_id: str(i, "batch_id"), query: str(i, "query"), qx_request_id: (i.qx_request_id as string | undefined) ?? null });
      if (!flag(i, "send")) return draft;
      const sent = sendFnmaCorrespondence(draft, { actor: ctx.actor, sent_on: today(i, ctx), evidence_document_id: (i.evidence_document_id as string | undefined) ?? null });   // the partner officer sends
      emitAll(ctx, draft.batch_id, [sent]);
      const rec = rt.store.get(BATCHES, draft.batch_id);
      if (rec && rec.data.status === "info_requested") { const t = transitionTransferOut(rec.data as unknown as TransferOutBatch, "submitted", { actor: ctx.actor }, today(i, ctx)); saveBatch(rt, t.batch, ctx); emitAll(ctx, draft.batch_id, t.events); }
      return { ...draft, status: "sent", sent_on: sent.payload.sent_on }; }),
    guardrails: [needsRole("FNMA_CORRESPONDENCE_IS_OFFICER", "17.1 escalations: `officer` (partner) for any Fannie Mae correspondence — the agent drafts, never sends", (i) => flag(i, "send"), OFFICER, "leave the draft for the partner officer to send")] },
  { name: "draftForm101Termination", kind: "act", handler: compute((i, ctx, rt) => {
      if (op(i, "draft") === "revoke_access") {   // Supermortgage disables the fnma-* adapters for the partner scope (SM_XFER_OUT_ACCESS_REVOCATION_5BD)
        need(i, "partner_id", "last_cutover_on", "revocation_log_id");
        const r = partnerAccessRevocation({ partner_id: str(i, "partner_id"), last_cutover_on: date(i, "last_cutover_on"), revoked_on: today(i, ctx), revocation_log_id: str(i, "revocation_log_id"), adapters: strings(i, "adapters"), related_party_users_removed: flag(i, "related_party_users_removed") });
        ctx.events.append({ type: r.event.type, aggregate: { kind: "transfer_batch", id: str(i, "batch_id") || str(i, "partner_id") }, actor: ctx.actor, payload: r.event.payload });
        return r;
      }
      if (op(i, "draft") === "form582_reflected") {   // A2-1-07: the partner's next Form 582 (18.4 filing.submitted{form=form_582}) no longer lists Supermortgage → form582.submitted{subservicer_removed} on the closed batch (FNMA_A2_1_07_FORM582_TERMINATION_REFLECTED)
        const b = loadBatch(i, rt); need(i, "filing", "supermortgage_servicer_number");
        const r = form582TerminationReflected({ batch: b, filing: filingOf(i.filing as Record<string, unknown>), supermortgage_servicer_number: str(i, "supermortgage_servicer_number") });
        emitAll(ctx, b.batch_id, r.events);
        if (r.subservicer_removed) rt.store.put(BATCHES, b.batch_id, { form582_reflected_at: r.event.payload.submitted_on, form582_reflected_filing_id: r.filing_id }, ctx.actor, ctx.now);
        return r;
      }
      need(i, "batch_id", "partner_servicer_number", "last_cutover_on");
      const draft = form101TerminationDraft({ batch_id: str(i, "batch_id"), partner_servicer_number: str(i, "partner_servicer_number"), last_cutover_on: date(i, "last_cutover_on") });
      if (!(flag(i, "submit") || flag(i, "send"))) return draft;
      need(i, "evidence_document_id");
      const s = submitForm101Termination(draft, { actor: ctx.actor, evidence_document_id: str(i, "evidence_document_id"), submitted_on: today(i, ctx), batch_id: str(i, "batch_id") });   // the officer's e-mail evidence
      emitAll(ctx, str(i, "batch_id"), [s.event]);
      return { ...draft, status: s.status, on_time: s.on_time }; }),
    guardrails: [needsRole("FORM101_TERMINATION_IS_OFFICER", "17.1 integrations: the Form 101 termination form is e-mailed by the partner `officer`", (i) => flag(i, "submit") || flag(i, "send"), OFFICER, "the agent pre-drafts; the partner officer e-mails Technology_Registration@fanniemae.com"), storeIsTheBatch] },
  { name: "writeDecision", kind: "act", handler: compute((i, ctx) => { const r = decisionRecord(i); if (!r.ok) throw new RangeError(`decision record is missing ${r.missing.join(", ")}`); return decision()({ ...i, action: str(i, "action") || "17.1 package", subject: { kind: "transfer_batch", id: str(i, "batch_id") } }, ctx); }),
    guardrails: [noFeeComputation] },
  { name: "notifyPartner", kind: "act", handler: compute((i, ctx) => {
      need(i, "batch_id", "subject");
      const n = partnerNotification({ batch_id: str(i, "batch_id"), subject: str(i, "subject"), audience: (i.audience as "partner" | "borrower" | undefined) ?? null });
      ctx.events.append({ type: n.event, aggregate: { kind: "transfer_batch", id: n.batch_id }, actor: ctx.actor, payload: { batch_id: n.batch_id, subject: n.subject, audience: n.audience } });
      return n; }),
    guardrails: [never("NO_BORROWER_CONTACT", "17.1 AI agent design: no borrower contact in 17.1 — borrower notices are 17.2 templates", (i) => str(i, "audience") === "borrower", "route borrower communications through 17.2")] },
]);
