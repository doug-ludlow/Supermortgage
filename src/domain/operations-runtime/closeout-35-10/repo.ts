/**
 * §35.10 — the closeout's own rows on the command's transaction (`Queryable`): refinance_closeouts (mutable; claimed
 * FOR UPDATE SKIP LOCKED, rule 10), refinance_closeout_steps (append-only journal), prior_loan_retirements, partner_retirement_notifications,
 * refinance_closeout_daily_receipts (append-only). Money columns are bigint (pg int8 → BigInt); dates are civil strings.
 */
import { randomUUID } from "node:crypto";
import { toJson, type Queryable } from "../../../infra/db/client.ts";
import type { PlainDate } from "../../../kernel/calendar/date.ts";
import type { CloseoutPatch, CloseoutRow, NotificationRow, ReceiptCounts, ReceiptRow, RetirementRow, StepEntry, StepRow, CloseoutMode, PriorStatus } from "./types.ts";

const CLOSEOUT_COLS = `id::text AS id, application_id::text AS application_id, prior_loan_id::text AS prior_loan_id, new_loan_id::text AS new_loan_id, orchestration_id::text AS orchestration_id, partner_party_id::text AS partner_party_id, mode, prior_status_at_open, step, status, waiting_on, hold_reason,
  payoff_demand_id, payoff_request_id, quote_id, statement_document_id, good_through::text AS good_through, quoted_total_cents, per_diem_cents, projected_disbursement_date::text AS projected_disbursement_date, disbursement_date::text AS disbursement_date, payoff_date::text AS payoff_date,
  funds_id, settlement_id, escrow_treatment, escrow_balance_cents, escrow_consent_id, escrow_credit_event_id::text AS escrow_credit_event_id, refund_disbursement_id, release_task_id, retirement_id::text AS retirement_id, partner_notification_id::text AS partner_notification_id,
  last_event_sequence, step_attempts, lease_holder, lease_until::text AS lease_until, opened_at::text AS opened_at, retired_at::text AS retired_at, completed_at::text AS completed_at, updated_at::text AS updated_at`;
const STEP_COLS = `id::text AS id, closeout_id::text AS closeout_id, application_id::text AS application_id, prior_loan_id::text AS prior_loan_id, step, kind, clocked, waiting_on, trigger_event_id::text AS trigger_event_id, command_process, command_name, command_op, actor_kind, actor_id, actor_role, decision_id::text AS decision_id, refusal_code, error_class, detail, sweep_run_id::text AS sweep_run_id, created_at::text AS created_at`;
const RET_COLS = `id::text AS id, prior_loan_id::text AS prior_loan_id, new_loan_id::text AS new_loan_id, application_id::text AS application_id, closeout_id::text AS closeout_id, mode, prior_status, retired_on::text AS retired_on, retirement_event_id::text AS retirement_event_id, settlement_event_id::text AS settlement_event_id, settlement_id, payoff_demand_id, payoff_total_cents, upb_cents, interest_cents, fees_cents, remitted_to, wire_reference, escrow_treatment, escrow_balance_cents, evidence_document_id, decision_id::text AS decision_id, created_at::text AS created_at`;
const NOTE_COLS = `id::text AS id, retirement_id::text AS retirement_id, prior_loan_id::text AS prior_loan_id, partner_party_id::text AS partner_party_id, kind, integration_message_id::text AS integration_message_id, channel, payload_hash, servicer_loan_number, notified_on::text AS notified_on, ack_reference, confirmation_source, confirmation_import_id::text AS confirmation_import_id, tape_status, escalation_id::text AS escalation_id, actor_kind, actor_id, created_at::text AS created_at`;
const RECEIPT_COLS = `id::text AS id, as_of_date::text AS as_of_date, open, by_mode, by_step, waiting_human, waiting_vendor, waiting_partner, held, retired_today, completed_today, unwound_today, releases_open, partner_unconfirmed, oldest_open_step, oldest_open_days, report_document_id, created_at::text AS created_at`;

const bigintCol = (v: unknown): bigint | null => (v === null || v === undefined ? null : typeof v === "bigint" ? v : BigInt(String(v)));
const rowOf = (r: Record<string, unknown>): CloseoutRow => ({ ...(r as unknown as CloseoutRow), quoted_total_cents: bigintCol(r["quoted_total_cents"]), per_diem_cents: bigintCol(r["per_diem_cents"]), escrow_balance_cents: bigintCol(r["escrow_balance_cents"]), last_event_sequence: bigintCol(r["last_event_sequence"]) ?? 0n, step_attempts: Number(r["step_attempts"] ?? 0) });

export interface NewCloseout { readonly id?: string; readonly application_id: string; readonly prior_loan_id: string; readonly partner_party_id: string | null; readonly mode: CloseoutMode; readonly prior_status_at_open: PriorStatus; readonly step: CloseoutRow["step"]; readonly status: CloseoutRow["status"]; readonly waiting_on?: string | null; readonly hold_reason?: string | null; readonly now: string; }

export async function insertCloseout(q: Queryable, c: NewCloseout): Promise<CloseoutRow> {
  const id = c.id ?? randomUUID();
  const rows = await q.query<Record<string, unknown>>(`INSERT INTO refinance_closeouts (id, application_id, prior_loan_id, partner_party_id, mode, prior_status_at_open, step, status, waiting_on, hold_reason, opened_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) RETURNING ${CLOSEOUT_COLS}`,
    [id, c.application_id, c.prior_loan_id, c.partner_party_id, c.mode, c.prior_status_at_open, c.step, c.status, c.waiting_on ?? null, c.hold_reason ?? null, c.now]);
  return rowOf(rows[0]!);
}
export async function closeoutById(q: Queryable, id: string, opts: { forUpdate?: boolean } = {}): Promise<CloseoutRow | null> {
  const rows = await q.query<Record<string, unknown>>(`SELECT ${CLOSEOUT_COLS} FROM refinance_closeouts WHERE id = $1${opts.forUpdate ? " FOR UPDATE SKIP LOCKED" : ""}`, [id]);
  return rows[0] ? rowOf(rows[0]) : null;
}
export async function closeoutByApplication(q: Queryable, applicationId: string, opts: { forUpdate?: boolean } = {}): Promise<CloseoutRow | null> {
  const rows = await q.query<Record<string, unknown>>(`SELECT ${CLOSEOUT_COLS} FROM refinance_closeouts WHERE application_id = $1${opts.forUpdate ? " FOR UPDATE SKIP LOCKED" : ""}`, [applicationId]);
  return rows[0] ? rowOf(rows[0]) : null;
}
export async function openCloseoutOnPriorLoan(q: Queryable, priorLoanId: string): Promise<CloseoutRow | null> {
  const rows = await q.query<Record<string, unknown>>(`SELECT ${CLOSEOUT_COLS} FROM refinance_closeouts WHERE prior_loan_id = $1 AND status NOT IN ('completed', 'unwound', 'cancelled') ORDER BY opened_at LIMIT 1`, [priorLoanId]);
  return rows[0] ? rowOf(rows[0]) : null;
}
/** Every closeout still open (any non-terminal status), oldest first. */
export async function openCloseouts(q: Queryable): Promise<CloseoutRow[]> {
  return (await q.query<Record<string, unknown>>(`SELECT ${CLOSEOUT_COLS} FROM refinance_closeouts WHERE status NOT IN ('completed', 'unwound', 'cancelled') ORDER BY opened_at, id`)).map(rowOf);
}
/** Refinance applications with a prior loan on the platform and no closeout yet (ONE_CLOSEOUT_PER_APPLICATION). */
export async function applicationsWithoutCloseout(q: Queryable): Promise<{ application_id: string; prior_loan_id: string; partner_party_id: string | null; prior_status: string }[]> {
  return q.query<{ application_id: string; prior_loan_id: string; partner_party_id: string | null; prior_status: string }>(
    `SELECT a.id::text AS application_id, a.prior_loan_id::text AS prior_loan_id, a.partner_party_id::text AS partner_party_id, l.status::text AS prior_status
       FROM applications a JOIN loans l ON l.id = a.prior_loan_id
      WHERE a.prior_loan_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM refinance_closeouts c WHERE c.application_id = a.id)
      ORDER BY a.created_at, a.id`);
}
const PATCHABLE = ["new_loan_id", "orchestration_id", "partner_party_id", "step", "status", "waiting_on", "hold_reason", "payoff_demand_id", "payoff_request_id", "quote_id", "statement_document_id", "good_through", "quoted_total_cents", "per_diem_cents", "projected_disbursement_date", "disbursement_date", "payoff_date", "funds_id", "settlement_id", "escrow_treatment", "escrow_balance_cents", "escrow_consent_id", "escrow_credit_event_id", "refund_disbursement_id", "release_task_id", "retirement_id", "partner_notification_id", "last_event_sequence", "step_attempts", "lease_holder", "lease_until", "retired_at", "completed_at"] as const;
export async function updateCloseout(q: Queryable, id: string, patch: CloseoutPatch, now: string): Promise<CloseoutRow> {
  const sets: string[] = []; const params: unknown[] = [id, now]; let n = 3;
  for (const k of PATCHABLE) { if (!(k in patch)) continue; sets.push(`${k} = $${n}`); params.push((patch as Record<string, unknown>)[k] ?? null); n += 1; }
  const rows = await q.query<Record<string, unknown>>(`UPDATE refinance_closeouts SET updated_at = $2${sets.length ? ", " + sets.join(", ") : ""} WHERE id = $1 RETURNING ${CLOSEOUT_COLS}`, params);
  if (!rows[0]) throw new RangeError(`no refinance_closeouts row ${id}`);
  return rowOf(rows[0]);
}

export async function appendStep(q: Queryable, s: StepEntry, now: string): Promise<StepRow> {
  const id = randomUUID();
  const rows = await q.query<Record<string, unknown>>(`INSERT INTO refinance_closeout_steps (id, closeout_id, application_id, prior_loan_id, step, kind, clocked, waiting_on, trigger_event_id, command_process, command_name, command_op, actor_kind, actor_id, actor_role, decision_id, refusal_code, error_class, detail, sweep_run_id, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20, $21) RETURNING ${STEP_COLS}`,
    [id, s.closeout_id, s.application_id, s.prior_loan_id, s.step, s.kind, s.clocked === true, s.waiting_on ?? null, s.trigger_event_id ?? null, s.command_process ?? null, s.command_name ?? null, s.command_op ?? null, s.actor_kind ?? null, s.actor_id ?? null, s.actor_role ?? null, s.decision_id ?? null, s.refusal_code ?? null, s.error_class ?? null, toJson(s.detail ?? {}), s.sweep_run_id ?? null, now]);
  return rows[0] as unknown as StepRow;
}
export async function stepsOf(q: Queryable, closeoutId: string): Promise<StepRow[]> {
  return (await q.query<Record<string, unknown>>(`SELECT ${STEP_COLS} FROM refinance_closeout_steps WHERE closeout_id = $1 ORDER BY created_at, id`, [closeoutId])) as unknown as StepRow[];
}

export interface NewRetirement extends Omit<RetirementRow, "id" | "created_at"> { readonly id?: string }
export async function insertRetirement(q: Queryable, r: NewRetirement, now: string): Promise<RetirementRow> {
  const id = r.id ?? randomUUID();
  const rows = await q.query<Record<string, unknown>>(`INSERT INTO prior_loan_retirements (id, prior_loan_id, new_loan_id, application_id, closeout_id, mode, prior_status, retired_on, retirement_event_id, settlement_event_id, settlement_id, payoff_demand_id, payoff_total_cents, upb_cents, interest_cents, fees_cents, remitted_to, wire_reference, escrow_treatment, escrow_balance_cents, evidence_document_id, decision_id, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23) RETURNING ${RET_COLS}`,
    [id, r.prior_loan_id, r.new_loan_id, r.application_id, r.closeout_id, r.mode, r.prior_status, r.retired_on, r.retirement_event_id, r.settlement_event_id, r.settlement_id, r.payoff_demand_id, r.payoff_total_cents, r.upb_cents, r.interest_cents, r.fees_cents, r.remitted_to, r.wire_reference, r.escrow_treatment, r.escrow_balance_cents, r.evidence_document_id, r.decision_id, now]);
  return retOf(rows[0]!);
}
const retOf = (r: Record<string, unknown>): RetirementRow => ({ ...(r as unknown as RetirementRow), payoff_total_cents: bigintCol(r["payoff_total_cents"]), upb_cents: bigintCol(r["upb_cents"]), interest_cents: bigintCol(r["interest_cents"]), fees_cents: bigintCol(r["fees_cents"]), escrow_balance_cents: bigintCol(r["escrow_balance_cents"]) });
export async function retirementsOf(q: Queryable, priorLoanId: string): Promise<RetirementRow[]> {
  return (await q.query<Record<string, unknown>>(`SELECT ${RET_COLS} FROM prior_loan_retirements WHERE prior_loan_id = $1 ORDER BY created_at, id`, [priorLoanId])).map(retOf);
}

export interface NewNotification extends Omit<NotificationRow, "id" | "created_at"> { readonly id?: string }
export async function insertNotification(q: Queryable, n: NewNotification, now: string): Promise<NotificationRow> {
  const id = n.id ?? randomUUID();
  const rows = await q.query<Record<string, unknown>>(`INSERT INTO partner_retirement_notifications (id, retirement_id, prior_loan_id, partner_party_id, kind, integration_message_id, channel, payload_hash, servicer_loan_number, notified_on, ack_reference, confirmation_source, confirmation_import_id, tape_status, escalation_id, actor_kind, actor_id, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING ${NOTE_COLS}`,
    [id, n.retirement_id, n.prior_loan_id, n.partner_party_id, n.kind, n.integration_message_id, n.channel, n.payload_hash, n.servicer_loan_number, n.notified_on, n.ack_reference, n.confirmation_source, n.confirmation_import_id, n.tape_status, n.escalation_id, n.actor_kind, n.actor_id, now]);
  return rows[0] as unknown as NotificationRow;
}
export async function notificationsOf(q: Queryable, retirementId: string): Promise<NotificationRow[]> {
  return (await q.query<Record<string, unknown>>(`SELECT ${NOTE_COLS} FROM partner_retirement_notifications WHERE retirement_id = $1 ORDER BY created_at, id`, [retirementId])) as unknown as NotificationRow[];
}

export async function insertReceipt(q: Queryable, asOf: PlainDate, c: ReceiptCounts, reportDocumentId: string | null, now: string): Promise<ReceiptRow> {
  const rows = await q.query<Record<string, unknown>>(`INSERT INTO refinance_closeout_daily_receipts (id, as_of_date, open, by_mode, by_step, waiting_human, waiting_vendor, waiting_partner, held, retired_today, completed_today, unwound_today, releases_open, partner_unconfirmed, oldest_open_step, oldest_open_days, report_document_id, created_at)
    VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING ${RECEIPT_COLS}`,
    [randomUUID(), asOf, c.open, toJson(c.by_mode), toJson(c.by_step), c.waiting_human, c.waiting_vendor, c.waiting_partner, c.held, c.retired_today, c.completed_today, c.unwound_today, c.releases_open, c.partner_unconfirmed, c.oldest_open_step, c.oldest_open_days, reportDocumentId, now]);
  return rows[0] as unknown as ReceiptRow;
}
export async function receiptFor(q: Queryable, asOf: PlainDate): Promise<ReceiptRow | null> {
  const rows = await q.query<Record<string, unknown>>(`SELECT ${RECEIPT_COLS} FROM refinance_closeout_daily_receipts WHERE as_of_date = $1`, [asOf]);
  return rows[0] ? (rows[0] as unknown as ReceiptRow) : null;
}
/** Rule 11: the counts are a direct query of refinance_closeouts (T15 compares them to the receipt). */
export async function boardCounts(q: Queryable, asOf: PlainDate): Promise<ReceiptCounts> {
  const open = await q.query<{ mode: string; step: string; status: string; opened_at: string }>(`SELECT mode, step, status, opened_at::text AS opened_at FROM refinance_closeouts WHERE status NOT IN ('completed', 'unwound', 'cancelled') ORDER BY opened_at`);
  const by = (key: "mode" | "step"): Record<string, number> => { const out: Record<string, number> = {}; for (const r of open) out[r[key]] = (out[r[key]] ?? 0) + 1; return out; };
  const count = (status: string): number => open.filter((r) => r.status === status).length;
  const day = async (col: string): Promise<number> => Number((await q.query<{ c: string }>(`SELECT count(*)::text AS c FROM refinance_closeouts WHERE ${col}::date = $1::date`, [asOf]))[0]!.c);
  const retired_today = Number((await q.query<{ c: string }>(`SELECT count(*)::text AS c FROM prior_loan_retirements WHERE retired_on = $1::date`, [asOf]))[0]!.c);
  const unwound_today = Number((await q.query<{ c: string }>(`SELECT count(*)::text AS c FROM refinance_closeouts WHERE status = 'unwound' AND updated_at::date = $1::date`, [asOf]))[0]!.c);
  const releases_open = open.filter((r) => r.step === "released_or_confirmed" && r.mode === "serviced_same_servicer").length;
  const partner_unconfirmed = open.filter((r) => r.step === "released_or_confirmed" && r.mode === "monitored_partner").length;
  const oldest = open[0] ?? null;
  const oldest_open_days = oldest ? Math.max(0, Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(oldest.opened_at)) / 86_400_000)) : null;
  return { open: open.length, by_mode: by("mode"), by_step: by("step"), waiting_human: count("waiting_human"), waiting_vendor: count("waiting_vendor"), waiting_partner: count("waiting_partner"), held: count("held"), retired_today, completed_today: await day("completed_at"), unwound_today, releases_open, partner_unconfirmed, oldest_open_step: oldest?.step ?? null, oldest_open_days };
}
