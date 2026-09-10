/**
 * §1.2 operating rules the batch state machine in inbound.ts and the `transfer` agent's tools call:
 *
 *  - The Form 629 `human_portal_task` (1.2 integrations: "Quick Exchange (portal-only) — `human_portal_task`
 *    package"). `openForm629PortalTask` validates the package the operator needs, registers the work item and
 *    appends `escalation.created{kind=human_portal_task, task=form629}` — the event the registry row
 *    SM_PORTAL_TASK_FORM629_SLA_2 arms on (anchor `created_at`, +2 business_days_servicer, breach "sev 2 →
 *    `officer`") and that TransferBatchService (inbound.ts) tracks so the operator's `escalation.completed`
 *    (EscalationService.complete: role-checked, with the confirmation evidence) moves the batch to `submitted`
 *    ("Transitions to `submitted` require a `fnma_portal_operator` completion record").
 *
 *  - The `package_ready` evidence gates (1.2 state machine: "`package_ready` (Form 629, loan list, Custodian
 *    Matrix, Forms 101/1013/1014/2017 evidence attached; DQ pre-check on the loan list passed)"; timer table
 *    FNMA_A2_1_07_FORM101_INCEPTION / FNMA_A2_1_07_FORMS_1013_1014_GATE / FNMA_A2_7_03_FORM2017_GATE, breach
 *    "package cannot reach `package_ready`", all triggered on `transfer.batch.proposed{first batch for this
 *    partner}`). `packageReadyGateBlock` is what `batchTransitionBlock` asserts.
 */
import { randomUUID } from "node:crypto";
import type { PlainDate } from "../../kernel/calendar/date.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { portalTaskEscalation, type TransferType } from "./batch.ts";
import type { BatchEvidence, BatchStatus } from "./inbound.ts";

// ---- package_ready evidence gates ------------------------------------------------------------------------
export type PackageReadyGate = "FNMA_A2_1_07_FORM101_INCEPTION" | "FNMA_A2_1_07_FORMS_1013_1014_GATE" | "FNMA_A2_7_03_FORM2017_GATE";
export interface PackageReadyGateResult { readonly code: PackageReadyGate; readonly applies: boolean; readonly ok: boolean; readonly reason: string | null; }
/**
 * The three not_before gates of the 1.2 timer table, each "same" trigger: `transfer.batch.proposed{first batch for
 * this partner}`. A later batch of the same partner inherits the arrangement's executed forms (A2-1-07: Form 101 "at
 * the inception of the subservicing arrangement"; Forms 1013/1014 "before Form 629 for a new arrangement"; Form 2017
 * between the transferee servicer and the custodian), so the gates apply to the partner's first batch.
 */
export function packageReadyGates(ev: BatchEvidence): PackageReadyGateResult[] {
  const applies = ev.first_batch_for_partner === true;
  const gate = (code: PackageReadyGate, ok: boolean, why: string): PackageReadyGateResult => ({ code, applies, ok: !applies || ok, reason: applies && !ok ? `${code}: ${why}` : null });
  const custodianMatches = !ev.form2017_custodian || !ev.transferee_custodian || ev.form2017_custodian === ev.transferee_custodian;
  return [
    gate("FNMA_A2_1_07_FORM101_INCEPTION", !!ev.form101_document_id, "no Form 101 evidence for the partner's first batch (A2-1-07: Form 101 at the inception of the subservicing arrangement)"),
    gate("FNMA_A2_1_07_FORMS_1013_1014_GATE", !!ev.form1013_document_id && !!ev.form1014_document_id, "no CBAM-executed Forms 1013/1014 evidence for the partner's first batch (A2-1-07; 6.1/6.2)"),
    gate("FNMA_A2_7_03_FORM2017_GATE", !!ev.form2017_document_id && custodianMatches, !ev.form2017_document_id ? "no Form 2017 Master Custodial Agreement evidence for the transferee custodian (A2-7-03; 1.4)" : `Form 2017 names custodian ${ev.form2017_custodian}, not the transferee custodian ${ev.transferee_custodian} (A2-7-03)`),
  ];
}
/** The first closed gate as the transition block ("package cannot reach `package_ready`"), or null when every gate is open. */
export function packageReadyGateBlock(ev: BatchEvidence): string | null {
  return packageReadyGates(ev).find((g) => !g.ok)?.reason ?? null;
}

// ---- the Form 629 portal task ---------------------------------------------------------------------------
export const FORM629_PORTAL_TASK_SLA = "SM_PORTAL_TASK_FORM629_SLA_2" as const;
export const FORM629_PORTAL_TASK_OWNER = "fnma_portal_operator" as const;
/** The Quick Exchange package the operator submits (1.2 integrations: "completed Form 629 Excel (template version recorded), Custodian Matrix Excel, loan-level list, transfer type, servicer numbers, subservicer indicator = Supermortgage, sale/transfer dates, custodian details, purchase price (sales), contact e-mails, checklist of attachments, expected confirmation artifacts (submission ID/screenshot)"). */
export interface Form629PortalTaskInput {
  readonly batch_id: string;
  /** The completed Form 629 (`documents`); `package_document_id` on the escalations row. */
  readonly package_document_id: string;
  readonly custodian_matrix_document_id?: string | null;
  readonly loan_list_version?: number | null;
  readonly loan_list_document_id?: string | null;
  readonly form629_template_version?: string | null;
  readonly transfer_type?: TransferType | null;
  readonly transfer_date?: PlainDate | null;
  readonly sale_date?: PlainDate | null;
  readonly transferor_servicer_number?: string | null;
  readonly transferee_servicer_number?: string | null;
  readonly purchase_price_bps?: string | null;
  readonly contact_emails?: readonly string[];
  /** Day the task is assigned; defaults to the Eastern-time civil date of the clock. The SLA is +2 servicer business days from it. */
  readonly assigned_on?: PlainDate | null;
  /** Who clicks in Quick Exchange (1.2 open question 1: partner user by default, or Supermortgage's `fnma_portal_operator` under Related-Party authorization). The completion record must come from this role. */
  readonly operator_role?: "fnma_portal_operator" | "partner_user";
  readonly reason?: string | null;
}
/** Escalation-shaped work item (src/app/escalations.ts `Escalation` and the `escalations` table, 0019), so the app's EscalationService can complete it and PgEscalationRepository can persist it. */
export interface PortalTaskRecord {
  readonly id: string; readonly kind: string; readonly ownerRole: string; readonly batchId?: string; readonly severity?: string;
  readonly openedAt: string; readonly openedBy: string; readonly payload: Record<string, unknown>; readonly slaTimerId?: string;
  status: "open" | "completed"; completedAt?: string; completedBy?: string; evidenceDocumentId?: string;
}
export interface Form629PortalTask extends PortalTaskRecord {
  readonly kind: "human_portal_task"; readonly batchId: string;
  readonly task: "form629";
  readonly sla: { readonly timer_code: typeof FORM629_PORTAL_TASK_SLA; readonly anchor: string; readonly assigned_on: PlainDate; readonly due: PlainDate };
  readonly checklist: { readonly attached: string[]; readonly missing: string[] };
  /** The `escalation.created` event SM_PORTAL_TASK_FORM629_SLA_2 armed on. */
  readonly event: DomainEvent;
}
export interface PortalTaskDeps {
  readonly events: EventStore;
  readonly clock: { now(): string };
  /** The app's EscalationService (its `opened` list) — the work item is registered there so `complete(id, operator, evidence)` closes it and emits `escalation.completed`. */
  readonly escalations?: { readonly opened: PortalTaskRecord[] };
  /** The batch the task is for, when the caller has it: the task is filed from `package_ready` (1.2 state machine: `package_ready` → `submitted` (portal task completed)). */
  readonly batch?: { readonly status: BatchStatus } | null;
}
const PACKAGE_ITEMS: readonly { key: keyof Form629PortalTaskInput; label: string }[] = [
  { key: "package_document_id", label: "form_629" }, { key: "custodian_matrix_document_id", label: "custodian_matrix" }, { key: "loan_list_version", label: "loan_list" },
  { key: "transfer_type", label: "transfer_type" }, { key: "transfer_date", label: "transfer_date" }, { key: "transferor_servicer_number", label: "transferor_servicer_number" }, { key: "transferee_servicer_number", label: "transferee_servicer_number" },
];
/**
 * Files the Form 629 Quick Exchange task: the `human_portal_task` escalation (owner `fnma_portal_operator` unless the
 * partner's user clicks), its package and the SLA the registry watches. Appends
 * `escalation.created{kind=human_portal_task, task=form629, batch_id, package_document_id, created_at, sla_due}`.
 */
export function openForm629PortalTask(deps: PortalTaskDeps, input: Form629PortalTaskInput, actor: Actor): Form629PortalTask {
  if (!input.batch_id) throw new RangeError("batch_id is required to file the Form 629 portal task");
  if (!input.package_document_id) throw new RangeError("package_document_id (the completed Form 629 package) is required to file the portal task");
  if (deps.batch && deps.batch.status !== "package_ready") throw new RangeError(`batch ${input.batch_id} is ${deps.batch.status}: the Form 629 portal task is filed from package_ready`);
  const now = deps.clock.now();
  const assignedOn = input.assigned_on ?? wallClock(Date.parse(now), "America/New_York").date;
  const due = portalTaskEscalation(assignedOn);   // +2 business_days_servicer (1.2 timer table; 1.2-T5)
  const attached = PACKAGE_ITEMS.filter((p) => input[p.key] !== undefined && input[p.key] !== null && input[p.key] !== "").map((p) => p.label);
  const missing = PACKAGE_ITEMS.map((p) => p.label).filter((l) => !attached.includes(l));
  const id = randomUUID();
  const ownerRole = input.operator_role === "partner_user" ? "partner_user" : FORM629_PORTAL_TASK_OWNER;
  const payload: Record<string, unknown> = {
    escalation_id: id, kind: "human_portal_task", task: "form629", owner_role: ownerRole, severity: null,
    batch_id: input.batch_id, package_document_id: input.package_document_id, custodian_matrix_document_id: input.custodian_matrix_document_id ?? null,
    loan_list_version: input.loan_list_version ?? null, loan_list_document_id: input.loan_list_document_id ?? null, form629_template_version: input.form629_template_version ?? null,
    transfer_type: input.transfer_type ?? null, transfer_date: input.transfer_date ?? null, sale_date: input.sale_date ?? null, subservicer_indicated: true,
    transferor_servicer_number: input.transferor_servicer_number ?? null, transferee_servicer_number: input.transferee_servicer_number ?? null, purchase_price_bps: input.purchase_price_bps ?? null,
    contact_emails: [...(input.contact_emails ?? [])], checklist_attached: attached, checklist_missing: missing, expected_evidence: ["submission_id", "screenshot"],
    created_at: now, assigned_on: assignedOn, sla_timer_code: FORM629_PORTAL_TASK_SLA, sla_due: due, reason: input.reason ?? null,
  };
  const event = deps.events.append({ type: "escalation.created", aggregate: { kind: "escalation", id }, actor, payload });
  const task: Form629PortalTask = { id, kind: "human_portal_task", ownerRole, batchId: input.batch_id, openedAt: now, openedBy: `${actor.kind}:${actor.id}`, payload, status: "open",
    task: "form629", sla: { timer_code: FORM629_PORTAL_TASK_SLA, anchor: "created_at", assigned_on: assignedOn, due }, checklist: { attached, missing }, event };
  deps.escalations?.opened.push(task);
  return task;
}
