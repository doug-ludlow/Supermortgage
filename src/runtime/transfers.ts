/**
 * Boarding a servicing-transfer batch in the hosted runtime (1.1 end to end):
 * the transferor's tape files → decode → BoardingService over in-memory
 * stores (ingest, stage, DQ gate, board when the transfer date has arrived)
 * → one Postgres transaction that writes the parties, properties, loans,
 * borrowers, loan terms, transfer batch and batch loans, validations, the
 * events, the 1.6 opening ledger sets, every timer the events armed, and an
 * escalation per hard exception so the ops console shows the work.
 *
 * Idempotent per batch id: a batch already on the platform returns its
 * summary and writes nothing (the tape hashes are the receipt).
 *
 * A batch whose transfer date is still ahead is staged and validated only;
 * boarding is refused by the state machine until the date (1.1 state
 * machine). A seed of a past-dated batch runs with the clock at the transfer
 * date so `loan.boarded` satisfies SM_BOARD_FIRST_CYCLE as it would have.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Queryable } from "../infra/db/client.ts";
import { toJson } from "../infra/db/client.ts";
import { MemoryEventStore, FixedClock, type Actor, type Clock } from "../kernel/events/index.ts";
import { MemoryLedger } from "../kernel/ledger/ledger.ts";
import { TimerEngine } from "../kernel/timers/engine.ts";
import { plainDate, type PlainDate } from "../kernel/calendar/date.ts";
import { BoardingService, type BatchLoan, type Scorecard } from "../domain/boarding/service.ts";
import type { BatchContext, ExternalPositions, FnmaPosition, MersRecord } from "../domain/boarding/types.ts";
import { decodeTransferBatch, type TransferBatchFiles } from "../domain/boarding/tape-codec.ts";
import { EscalationService } from "../app/escalations.ts";
import type { Runtime } from "./app.ts";

export interface TransferBatchInput {
  readonly batch_id: string;
  readonly transfer_date: PlainDate;
  readonly respa_effective_date?: PlainDate;
  readonly sale_date?: PlainDate | null;
  readonly transferor_name: string;
  readonly transferor_servicer_number: string;
  readonly partner_servicer_number: string;
  readonly transferor_mers_org_id: string;
  readonly partner_mers_org_id: string;
  readonly d_code?: string | null;
  readonly transfer_type?: "master_to_sub" | "sub_to_sub" | "servicing_sale_with_sub" | "custodian_only";
  readonly rule_set_version?: string;
  /** States Supermortgage holds a servicer license for (HF-020); defaults to the platform's list. */
  readonly licensed_states?: readonly string[];
  readonly final_tape_reconciled?: boolean;
}
export interface TransferBatchSummary {
  readonly batch_id: string;
  readonly batch_uuid: string;
  readonly status: "boarded" | "staged" | "already_on_platform";
  readonly transfer_date: PlainDate;
  readonly loans: { staged: number; validated: number; exception: number; boarded: number };
  readonly hard: Record<string, number>;
  readonly warning: Record<string, number>;
  readonly hard_by_loan: Record<string, string[]>;
  readonly events: number;
  readonly timers: number;
  readonly escalations: number;
  readonly loan_ids: Record<string, string>;
  readonly upb_total_cents: bigint;
}

export const DEFAULT_LICENSED_STATES: readonly string[] = ["TX", "CA", "FL", "NY", "IL", "OH", "PA", "GA", "NC", "AZ", "WA", "CO", "MN", "NJ", "MD"];
const BOARDING_ACTOR: Actor = { kind: "agent", id: "boarding" };

/** A stable uuid for a human batch id, so the same batch cannot board twice. */
export function batchUuid(batchId: string): string {
  const h = createHash("sha256").update(`supermortgage:transfer_batch:${batchId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(8 + (parseInt(h[16]!, 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const pctToBps = (pct: string | null, scale: number): number | null => (pct === null ? null : Math.round(Number(pct) * scale));
const monthsBetween = (a: PlainDate, b: PlainDate): number => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7)));

export async function boardTransferBatch(rt: Runtime, input: TransferBatchInput, files: TransferBatchFiles, actor: Actor): Promise<TransferBatchSummary> {
  const uuid = batchUuid(input.batch_id);
  const existing = await rt.entities.current("transfer_batches", input.batch_id);
  if (existing) return { ...(existing.data as unknown as TransferBatchSummary), status: "already_on_platform" };
  const data = decodeTransferBatch(files);
  const today = plainDate(rt.clock.now().slice(0, 10));
  const transferDateReached = today >= input.transfer_date;
  // a past-dated batch is boarded as of its transfer date (the cutover), so the clocks that boarding satisfies read as satisfied on time
  const clock: Clock = transferDateReached && today > input.transfer_date ? new FixedClock(`${input.transfer_date}T09:00:00.000Z`) : rt.clock;

  // external positions: the files, the platform's licenses, and what is already on the platform (HF-017)
  const fnma = new Map<string, FnmaPosition>(data.fnma.map((p) => [p.fnma_loan_number, p]));
  const tb = new Map(data.trialBalance.map((t) => [t.transferor_loan_number, t.upb_cents]));
  const mers = new Map<string, MersRecord>(data.mers.map((m) => [m.min, m]));
  const licensed = new Set(input.licensed_states ?? DEFAULT_LICENSED_STATES);
  const numbers = data.loans.map((l) => l.fnma_loan_number).filter((n): n is string => !!n);
  const mins = data.loans.map((l) => l.min).filter((m): m is string => !!m);
  const onPlatform = { fnma_loan_number: new Set<string>(), min: new Set<string>() };
  if (numbers.length) for (const r of await rt.db.query<{ n: string }>(`SELECT fnma_loan_number AS n FROM loans WHERE fnma_loan_number = ANY($1::text[])`, [numbers])) onPlatform.fnma_loan_number.add(r.n);
  if (mins.length) for (const r of await rt.db.query<{ m: string }>(`SELECT min AS m FROM loans WHERE min = ANY($1::text[])`, [mins])) onPlatform.min.add(r.m);
  const ext: ExternalPositions = { fnma: (n) => fnma.get(n), trialBalanceUpb: (n) => tb.get(n), mers: (m) => mers.get(m), licensed: (s) => licensed.has(s), onPlatform: (k, v) => onPlatform[k].has(v) };

  return rt.db.tx(async (q) => {
    // the parties and the clearing account the opening entries balance against
    const transferorParty = await partyId(q, "transferor", input.transferor_name, input.transferor_servicer_number, input.transferor_mers_org_id);
    const partnerParty = await partyId(q, "servicer", "Supermortgage", input.partner_servicer_number, input.partner_mers_org_id);
    const clearing = await custodialAccount(q, partnerParty, "clearing");

    const events = new MemoryEventStore(clock);
    const ledger = new MemoryLedger();
    const timers = new TimerEngine(rt.registry, events);
    const escalations = new EscalationService(events, clock);
    const svc = new BoardingService({ events, ledger, ext, clock, clearingAccountId: clearing, loanIdFor: (bl) => bl.id });
    const ctx: BatchContext = { batch_id: uuid, transfer_date: input.transfer_date, transferor_party_id: transferorParty, transferor_servicer_number: input.transferor_servicer_number, partner_servicer_number: input.partner_servicer_number,
      rule_set_version: input.rule_set_version ?? "boarding.dq.v1", acceptable_mers_org_ids: new Set([input.partner_mers_org_id, input.transferor_mers_org_id]) };
    svc.openBatch(ctx);
    const tapeKinds: Record<string, string> = { "boarding_tape.final.csv": "final", "payment_history.csv": "payment_history", "escrow_history.csv": "escrow_history", "escrow_analysis.csv": "escrow_analysis", "lossmit_file.csv": "lossmit", "fc_bk_file.csv": "fc_bk", "consents_file.csv": "consents", "images_manifest.csv": "images_manifest", "trial_balance.csv": "trial_balance" };
    for (const [name, kind] of Object.entries(tapeKinds)) { const text = files[name as keyof TransferBatchFiles]; if (text) svc.ingestTape(uuid, kind as "final", text, Math.max(0, text.split("\n").filter((l) => l.length).length - 1)); }
    const staged = svc.stage(uuid, data.loans);
    const card: Scorecard = svc.validate(uuid);
    const boarded = transferDateReached ? svc.board(uuid, { finalTapeReconciled: input.final_tape_reconciled ?? true }).boarded : [];
    const boardedIds = new Set(boarded.map((bl) => bl.id));
    // one escalation per hard exception so the console's queues show the loans that cannot board
    for (const bl of staged) {
      const hard = bl.validations.filter((v) => v.severity === "hard" && v.result === "fail");
      if (!hard.length) continue;
      const money = hard.some((v) => v.money_field);
      escalations.open({ kind: money ? "officer" : "human_portal_task", ownerRole: money ? "officer" : "ops_analyst", loanId: bl.id, batchId: uuid, severity: "2",
        payload: { transferor_loan_number: bl.staged.transferor_loan_number, fnma_loan_number: bl.staged.fnma_loan_number, rules: hard.map((v) => ({ code: v.code, message: v.message ?? null, expected: v.expected ?? null, actual: v.actual ?? null, money_field: v.money_field })), next: money ? "transferor correction or officer waiver (money field)" : "transferor correction, agent correction with evidence, or officer waiver" } }, BOARDING_ACTOR);
    }

    // ---- persist: rows first (the events reference them), then the log, ledger, timers, escalations
    const upbTotal = staged.reduce((s, bl) => s + (bl.staged.upb_cents ?? 0n), 0n);
    const escrowTotal = staged.reduce((s, bl) => s + bl.staged.escrow_balance_cents, 0n);
    await q.query(`INSERT INTO transfer_batches (id, transfer_type, transferor_party_id, transferor_servicer_number, partner_servicer_number, sale_date, transfer_date, respa_effective_date, d_code, status, loan_count, upb_total_cents, escrow_total_cents, rule_set_version)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [uuid, input.transfer_type ?? "servicing_sale_with_sub", transferorParty, input.transferor_servicer_number, input.partner_servicer_number, input.sale_date ?? null, input.transfer_date, input.respa_effective_date ?? input.transfer_date, input.d_code ?? null, boarded.length ? "cutover" : "staging", staged.length, upbTotal, escrowTotal, ctx.rule_set_version]);
    const runId = randomUUID();
    for (const bl of staged) {
      const s = bl.staged; const isBoarded = boardedIds.has(bl.id);
      const prop = await q.query<{ id: string }>(`INSERT INTO properties (address_line1, city, state, postal_code, tax_parcel_verified, occupancy) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [s.property.address_line1 ?? "(unknown)", s.property.city ?? "(unknown)", s.property.state ?? "XX", s.property.postal_code ?? "00000", s.tax_parcel_verified, s.property.occupancy ?? null]);
      await q.query(`INSERT INTO loans (id, fnma_loan_number, servicer_loan_number, transferor_loan_number, min, mers_eligible, partner_party_id, prior_servicer_party_id, property_id, status, instrument_date, origination_date, original_upb_cents, original_term_months, first_payment_date, maturity_date, emortgage, boarded_at, boarding_batch_id, default_status_at_boarding, fdcpa_debt_collector_flag, regx_days_delinquent_at_boarding, fnma_delinquency_status_at_boarding)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
        [bl.id, s.fnma_loan_number ?? `PENDING${bl.id.slice(0, 3)}`, `SM-${s.transferor_loan_number}`, s.transferor_loan_number, s.min, s.mers_eligible, partnerParty, transferorParty, prop[0]!.id, isBoarded ? "active" : "staged",
          s.instrument_date, s.origination_date, s.original_upb_cents ?? 1n, s.original_term_months ?? 360, s.first_payment_date ?? s.instrument_date, s.maturity_date ?? s.instrument_date, !!s.custody?.enote_evault_ref,
          isBoarded ? clock.now() : null, uuid, bl.default_status_at_boarding ?? null, bl.fdcpa_debt_collector_flag ?? null, bl.regx_days_delinquent_at_boarding ?? null, bl.fnma_delinquency_status_at_boarding ?? null]);
      const b = await q.query<{ id: string }>(`INSERT INTO borrowers (legal_name, tin_last4, preferred_language, scra_active) VALUES ($1, $2, $3, $4) RETURNING id`, [s.borrower.legal_name ?? "(unknown)", s.borrower.tin ? s.borrower.tin.replace(/\D/g, "").slice(-4) : null, s.borrower.preferred_language ?? null, s.scra.active]);
      await q.query(`INSERT INTO loan_borrowers (loan_id, borrower_id, role, is_primary) VALUES ($1, $2, 'borrower', true)`, [bl.id, b[0]!.id]);
      if (isBoarded) {
        const a = s.arm ?? {};
        await q.query(`INSERT INTO loan_terms (loan_id, effective_from, source, amortization, note_rate_bps, pi_cents, escrow_payment_cents, escrowed, interest_method, remittance_type, late_charge_pct_bps, late_charge_grace_days, maturity_date, remaining_term_months, deferred_principal_cents, forborne_principal_cents, arm_index, arm_margin_bps, arm_initial_cap_bps, arm_periodic_cap_bps, arm_lifetime_cap_bps, arm_lookback_days)
          VALUES ($1, $2, 'boarding', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
          [bl.id, input.transfer_date, s.amortization, pctToBps(s.note_rate_pct, 10_000) ?? 0, s.pi_cents ?? 0n, s.escrow_payment_cents, s.escrowed, s.interest_method ?? "30_360", s.remittance_type ?? "A/A", pctToBps(s.late_charge_pct, 1000), s.late_charge_grace_days, s.maturity_date ?? input.transfer_date,
            s.first_payment_date && s.next_due_date && s.original_term_months !== null ? s.original_term_months - monthsBetween(s.first_payment_date, s.next_due_date) : null, s.deferred_principal_cents, s.forborne_principal_cents, a.index ?? null, a.margin_bps ?? null, a.initial_cap_bps ?? null, a.periodic_cap_bps ?? null, a.lifetime_cap_bps ?? null, a.lookback_days ?? null]);
      }
      await q.query(`INSERT INTO transfer_batch_loans (id, batch_id, transferor_loan_number, fnma_loan_number, min, loan_id, boarding_status, boarding_hold, default_status_at_boarding, regx_days_delinquent_at_boarding, fnma_delinquency_status_at_boarding, fdcpa_debt_collector_flag, lossmit_in_process, fc_active, bk_active, scra_active, sii_present, emortgage, acp_enrolled)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [bl.id, uuid, s.transferor_loan_number, s.fnma_loan_number ?? `PENDING${bl.id.slice(0, 3)}`, s.min, isBoarded ? bl.id : null, bl.status, bl.boarding_hold, bl.default_status_at_boarding ?? null, bl.regx_days_delinquent_at_boarding ?? null, bl.fnma_delinquency_status_at_boarding ?? null, bl.fdcpa_debt_collector_flag ?? null,
          s.lossmit.in_process, s.foreclosure.active, s.bankruptcy.active, s.scra.active, s.sii.present, !!s.custody?.enote_evault_ref, s.acp_enrolled]);
      for (const v of bl.validations) await q.query(`INSERT INTO boarding_validations (batch_loan_id, run_id, rule_code, severity, result, expected, actual, message, rule_set_version) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
        [bl.id, runId, v.code, v.severity, v.result, v.expected === undefined ? null : toJson(v.expected), v.actual === undefined ? null : toJson(v.actual), v.message ?? null, ctx.rule_set_version]);
    }
    const persisted = await rt.uow.events.append(events.since(0), q);
    for (const set of ledger.sets()) await rt.uow.ledger.post(set, q);
    await rt.uow.timers.save(timers.all(), q);
    for (const e of escalations.list()) await rt.escalationRepo.save(e, q);

    const hardByLoan: Record<string, string[]> = {};
    for (const bl of staged) { const codes = bl.validations.filter((v) => v.severity === "hard" && v.result === "fail").map((v) => v.code); if (codes.length) hardByLoan[bl.staged.transferor_loan_number] = codes; }
    const summary: TransferBatchSummary = { batch_id: input.batch_id, batch_uuid: uuid, status: boarded.length ? "boarded" : "staged", transfer_date: input.transfer_date,
      loans: { staged: staged.length, validated: card.loans["validated"], exception: card.loans["exception"], boarded: boarded.length }, hard: card.hard, warning: card.warning, hard_by_loan: hardByLoan,
      events: persisted.length, timers: timers.all().length, escalations: escalations.list().length, loan_ids: Object.fromEntries(staged.map((bl) => [bl.staged.transferor_loan_number, bl.id])), upb_total_cents: upbTotal };
    await rt.entities.save([{ kind: "transfer_batches", id: input.batch_id, version: 1, data: summary as unknown as Record<string, unknown>, updatedAt: clock.now(), updatedBy: `${actor.kind}:${actor.id}` }], null, q);
    return summary;
  });
}

async function partyId(q: Queryable, type: "transferor" | "servicer", name: string, servicerNumber: string, mersOrgId: string): Promise<string> {
  const found = await q.query<{ id: string }>(`SELECT id FROM parties WHERE party_type = $1 AND servicer_number = $2 LIMIT 1`, [type, servicerNumber]);
  if (found[0]) return found[0].id;
  const made = await q.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ($1, $2, $3, $4) RETURNING id`, [type, name, servicerNumber, mersOrgId]);
  return made[0]!.id;
}
async function custodialAccount(q: Queryable, partnerPartyId: string, kind: string): Promise<string> {
  const found = await q.query<{ id: string }>(`SELECT id FROM custodial_accounts WHERE partner_party_id = $1 AND kind = $2 LIMIT 1`, [partnerPartyId, kind]);
  if (found[0]) return found[0].id;
  const made = await q.query<{ id: string }>(`INSERT INTO custodial_accounts (partner_party_id, kind, remittance_type) VALUES ($1, $2, 'A/A') RETURNING id`, [partnerPartyId, kind]);
  return made[0]!.id;
}

export type { BatchLoan };
