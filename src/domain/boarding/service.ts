/**
 * Boarding service — the `boarding` agent's tool surface for process 1.1:
 * readTape / runValidation / raiseException / proposeWaiver / boardLoan /
 * sendTransferorQuery / writeDecision. Deterministic and in-memory here; the
 * Postgres repository binds the same operations to the 0002_boarding tables.
 */
import { createHash, randomUUID } from "node:crypto";
import type { EventStore, Actor, DomainEvent } from "../../kernel/events/index.ts";
import type { Ledger, EntrySet } from "../../kernel/ledger/ledger.ts";
import { type PlainDate, min as minDate, plainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, type CalendarSet, defaultCalendars } from "../../kernel/calendar/business.ts";
import { monthlyInterest, ratePercent } from "../../kernel/money/cents.ts";
import { applyFifo, earliestUnpaidDueDate, regxDaysDelinquent, fnmaDelinquencyStatus, isUnpaidAsOf, type AppliedInstallment } from "./delinquency.ts";
import { runRules, ALL_RULES, RULE_SET_VERSION } from "./rules.ts";
import { boardingMachine, type BoardingStatus } from "./machine.ts";
import type { StagedLoan, BatchContext, ExternalPositions, RuleResult } from "./types.ts";

export const BOARDING_AGENT: Actor = { kind: "agent", id: "boarding" };

export type TapeKind = "preliminary" | "final" | "payment_history" | "escrow_history" | "escrow_analysis" | "lossmit" | "fc_bk" | "images_manifest" | "consents" | "correspondence" | "trial_balance";

export interface Tape { readonly id: string; readonly batch_id: string; readonly kind: TapeKind; readonly sha256: string; readonly row_count: number; readonly received_at: string; }
export interface TapeReceipt { readonly status: "accepted" | "duplicate"; readonly tape_id: string; readonly sha256: string; readonly received_at: string; }

export interface Validation extends RuleResult { readonly id: number; readonly run_id: string; readonly waived?: { by: Actor; reason: string; decision_id: string }; }

export interface BatchLoan {
  readonly id: string;
  readonly batch_id: string;
  readonly staged: StagedLoan;
  status: BoardingStatus;
  loan_id?: string;
  boarding_hold: boolean;
  validations: Validation[];
  applied: readonly AppliedInstallment[];
  first_cycle_due: PlainDate;
  regx_days_delinquent_at_boarding?: number;
  fnma_delinquency_status_at_boarding?: string;
  default_status_at_boarding?: boolean;
  fdcpa_debt_collector_flag?: boolean;
}

export interface AgentDecision {
  readonly id: string; readonly agent: string; readonly batch_loan_id: string; readonly rule_code: string; readonly action: string;
  readonly evidence_document_ids: readonly string[]; readonly confidence: number | null; readonly rule_set_version: string;
  readonly model_version: string | null; readonly prompt_version: string | null; readonly rationale: string;
  readonly approved_by?: string; readonly approved_role?: string; readonly created_at: string;
}

export interface Scorecard {
  readonly batch_id: string; readonly generated_at: string; readonly rule_set_version: string;
  readonly loans: Record<BoardingStatus, number>;
  readonly hard: Record<string, number>; readonly warning: Record<string, number>;
  readonly hard_fail_rate: number;
}

export interface TransferorQuery {
  readonly batch_loan_id: string; readonly transferor_loan_number: string; readonly fnma_loan_number: string | null;
  readonly items: readonly { rule_code: string; message: string; expected: unknown; actual: unknown; money_field: boolean }[];
}

export type WaiverResult =
  | { ok: true; decision: AgentDecision }
  | { ok: false; code: "ROLE_DENIED" | "NOT_FOUND" | "NOT_FAILED"; reason: string };

export interface BoardingDeps {
  readonly events: EventStore;
  readonly ledger: Ledger;
  readonly ext: ExternalPositions;
  readonly calendars?: CalendarSet;
  readonly clock: { now(): string };
  /** Custodial clearing account id for opening postings (1.6). */
  readonly clearingAccountId: string;
  /** Per-loan servicer id generator; deterministic in tests. */
  readonly loanIdFor?: (bl: BatchLoan) => string;
}

export class BoardingService {
  private readonly batches = new Map<string, BatchContext>();
  private readonly tapes = new Map<string, Tape>();            // by sha256
  private readonly loans = new Map<string, BatchLoan>();
  private readonly decisions: AgentDecision[] = [];
  private readonly boardedLoanNumbers = new Set<string>();
  private validationSeq = 0;
  private readonly cals: CalendarSet;
  private readonly deps: BoardingDeps;

  constructor(deps: BoardingDeps) { this.deps = deps; this.cals = deps.calendars ?? defaultCalendars; }

  // ───────── batch ─────────
  openBatch(ctx: BatchContext): void { this.batches.set(ctx.batch_id, ctx); }
  batch(id: string): BatchContext { const b = this.batches.get(id); if (!b) throw new RangeError(`no batch ${id}`); return b; }
  batchLoans(batchId: string): readonly BatchLoan[] { return [...this.loans.values()].filter((l) => l.batch_id === batchId); }
  batchLoan(id: string): BatchLoan { const l = this.loans.get(id); if (!l) throw new RangeError(`no batch loan ${id}`); return l; }
  decisionsFor(batchLoanId: string): readonly AgentDecision[] { return this.decisions.filter((d) => d.batch_loan_id === batchLoanId); }

  // ───────── tape intake (1.1-T10 idempotency by file hash) ─────────
  ingestTape(batchId: string, kind: TapeKind, bytes: Uint8Array | string, rowCount: number): TapeReceipt {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const existing = this.tapes.get(sha256);
    if (existing) return { status: "duplicate", tape_id: existing.id, sha256, received_at: existing.received_at };
    const tape: Tape = { id: randomUUID(), batch_id: batchId, kind, sha256, row_count: rowCount, received_at: this.deps.clock.now() };
    this.tapes.set(sha256, tape);
    this.deps.events.append({ type: "transfer.tape.received", aggregate: { kind: "transfer_batch", id: batchId }, actor: { kind: "external", id: "transferor_sftp" },
      payload: { kind, tape_id: tape.id, sha256, row_count: rowCount } });
    return { status: "accepted", tape_id: tape.id, sha256, received_at: tape.received_at };
  }

  // ───────── staging ─────────
  /**
   * Stage canonical rows. Computes the SM_BOARD_FIRST_CYCLE anchor per spec:
   * earliest of (transfer_date + 3 business_days_servicer) and (first next_due_date ≥ transfer_date).
   */
  stage(batchId: string, rows: readonly StagedLoan[]): BatchLoan[] {
    const b = this.batch(batchId);
    const out: BatchLoan[] = [];
    for (const staged of rows) {
      const plus3 = addBusinessDays(b.transfer_date, 3, this.cals.business_days_servicer);
      const nextDue = staged.next_due_date && staged.next_due_date >= b.transfer_date ? staged.next_due_date : undefined;
      const first_cycle_due = nextDue ? minDate(plus3, nextDue) : plus3;
      const bl: BatchLoan = { id: randomUUID(), batch_id: batchId, staged, status: "staged", boarding_hold: false, validations: [],
        applied: applyFifo(staged.installments, staged.payments).installments, first_cycle_due };
      this.loans.set(bl.id, bl);
      out.push(bl);
      this.deps.events.append({ type: "loan.staged", loanId: bl.id, aggregate: { kind: "transfer_batch", id: batchId }, actor: BOARDING_AGENT,
        payload: { batch_loan_id: bl.id, transferor_loan_number: staged.transferor_loan_number, fnma_loan_number: staged.fnma_loan_number, transfer_date: b.transfer_date, first_cycle_due } });
    }
    return out;
  }

  // ───────── validation (nightly `boarding.stage.validate`) ─────────
  validate(batchId: string): Scorecard {
    const b = this.batch(batchId);
    const loans = this.batchLoans(batchId);
    const loanNumbers = new Map<string, number>(), mins = new Map<string, number>();
    for (const l of loans) {
      if (l.staged.fnma_loan_number) loanNumbers.set(l.staged.fnma_loan_number, (loanNumbers.get(l.staged.fnma_loan_number) ?? 0) + 1);
      if (l.staged.min) mins.set(l.staged.min, (mins.get(l.staged.min) ?? 0) + 1);
    }
    const run_id = randomUUID();
    for (const bl of loans) {
      if (bl.status !== "staged" && bl.status !== "exception" && bl.status !== "validated") continue;
      const prevWaived = new Map(bl.validations.filter((v) => v.waived).map((v) => [v.code, v.waived!]));
      const results = runRules({ loan: bl.staged, batch: b, ext: this.deps.ext, batchCounts: { loanNumbers, mins } }, ALL_RULES);
      bl.validations = results.map((r) => {
        const w = prevWaived.get(r.code);
        return { ...r, id: ++this.validationSeq, run_id, ...(w ? { waived: w } : {}) };
      });
      const openHard = this.openHardFailures(bl);
      const t = boardingMachine.attempt(bl.status, "validate", BOARDING_AGENT, { openHardFailures: openHard.length, transferDateReached: false, finalTapeReconciled: false, onApprovedList: true });
      if (!t.ok) continue;
      const prior = bl.status;
      bl.status = t.to;
      if (t.to === "validated") {
        this.deps.events.append({ type: "loan.validated", loanId: bl.id, aggregate: { kind: "transfer_batch", id: batchId }, actor: BOARDING_AGENT,
          payload: { batch_loan_id: bl.id, run_id, warnings: bl.validations.filter((v) => v.severity === "warning" && v.result === "fail" && !v.waived).map((v) => v.code), prior_status: prior } });
        if (prior === "exception") this.deps.events.append({ type: "loan.boarding_exception.resolved", loanId: bl.id, actor: BOARDING_AGENT, payload: { batch_loan_id: bl.id, run_id } });
      } else {
        for (const v of openHard) this.deps.events.append({ type: "loan.boarding_exception.raised", loanId: bl.id, aggregate: { kind: "transfer_batch", id: batchId }, actor: BOARDING_AGENT,
          payload: { batch_loan_id: bl.id, rule_code: v.code, severity: "hard", money_field: v.money_field, raised_at: this.deps.clock.now(), run_id, expected: v.expected ?? null, actual: v.actual ?? null } });
      }
    }
    return this.scorecard(batchId);
  }

  openHardFailures(bl: BatchLoan): Validation[] { return bl.validations.filter((v) => v.severity === "hard" && v.result === "fail" && !v.waived); }
  openWarnings(bl: BatchLoan): Validation[] { return bl.validations.filter((v) => v.severity === "warning" && v.result === "fail" && !v.waived); }

  scorecard(batchId: string): Scorecard {
    const loans = this.batchLoans(batchId);
    const statuses: Record<BoardingStatus, number> = { staged: 0, validated: 0, exception: 0, boarded: 0, reconciled: 0, active: 0, rejected_to_transferor: 0, withdrawn: 0 };
    const hard: Record<string, number> = {}, warning: Record<string, number> = {};
    for (const l of loans) {
      statuses[l.status]++;
      for (const v of this.openHardFailures(l)) hard[v.code] = (hard[v.code] ?? 0) + 1;
      for (const v of this.openWarnings(l)) warning[v.code] = (warning[v.code] ?? 0) + 1;
    }
    const failing = loans.filter((l) => this.openHardFailures(l).length > 0).length;
    return { batch_id: batchId, generated_at: this.deps.clock.now(), rule_set_version: RULE_SET_VERSION, loans: statuses, hard, warning, hard_fail_rate: loans.length ? failing / loans.length : 0 };
  }

  /** Row-level correction request for the transferor: every open hard failure with both values. */
  transferorQuery(batchLoanId: string): TransferorQuery {
    const bl = this.batchLoan(batchLoanId);
    return { batch_loan_id: bl.id, transferor_loan_number: bl.staged.transferor_loan_number, fnma_loan_number: bl.staged.fnma_loan_number,
      items: this.openHardFailures(bl).map((v) => ({ rule_code: v.code, message: v.message ?? "", expected: v.expected, actual: v.actual, money_field: v.money_field })) };
  }

  // ───────── waivers (every waiver needs a human; money fields need an officer) ─────────
  proposeWaiver(batchLoanId: string, ruleCode: string, actor: Actor, reason: string, evidenceDocumentIds: readonly string[] = []): WaiverResult {
    const bl = this.loans.get(batchLoanId);
    if (!bl) return { ok: false, code: "NOT_FOUND", reason: `no batch loan ${batchLoanId}` };
    const v = bl.validations.find((x) => x.code === ruleCode);
    if (!v || v.result !== "fail") return { ok: false, code: "NOT_FAILED", reason: `${ruleCode} is not an open failure` };
    // Guardrail: a waiver is a human act. Agents may propose, never approve; money fields require `officer`.
    if (actor.kind !== "human") return { ok: false, code: "ROLE_DENIED", reason: `waiver of ${ruleCode} requires a human approval record (actor ${actor.kind}:${actor.id})` };
    if ((v.money_field || v.severity === "hard") && actor.role !== "officer") return { ok: false, code: "ROLE_DENIED", reason: `waiver of ${v.severity} rule ${ruleCode}${v.money_field ? " (money field)" : ""} requires role officer` };
    const decision: AgentDecision = { id: randomUUID(), agent: "boarding", batch_loan_id: bl.id, rule_code: ruleCode, action: "waived_with_reason", evidence_document_ids: [...evidenceDocumentIds],
      confidence: null, rule_set_version: RULE_SET_VERSION, model_version: null, prompt_version: null, rationale: reason, approved_by: actor.id, approved_role: actor.role ?? "", created_at: this.deps.clock.now() };
    this.decisions.push(decision);
    bl.validations = bl.validations.map((x) => (x.code === ruleCode ? { ...x, waived: { by: actor, reason, decision_id: decision.id } } : x));
    this.deps.events.append({ type: "loan.boarding_validation.waived", loanId: bl.id, actor, payload: { batch_loan_id: bl.id, rule_code: ruleCode, decision_id: decision.id, money_field: v.money_field } });
    if (this.openHardFailures(bl).length === 0 && bl.status === "exception") {
      bl.status = "validated";
      this.deps.events.append({ type: "loan.validated", loanId: bl.id, actor, payload: { batch_loan_id: bl.id, via: "waiver" } });
      this.deps.events.append({ type: "loan.boarding_exception.resolved", loanId: bl.id, actor, payload: { batch_loan_id: bl.id, resolution: "waived_with_reason" } });
    }
    return { ok: true, decision };
  }

  // ───────── boarding ─────────
  /**
   * Board every validated loan: derive default status per §1024.31 FIFO, write
   * the 1.6 opening entry set, emit `loan.boarded` (payload carries every field
   * the Section 1 timers anchor on) and seed 11.1/11.2 delinquency windows.
   */
  board(batchId: string, opts: { finalTapeReconciled: boolean }): { boarded: BatchLoan[]; refused: { loan: BatchLoan; reason: string }[] } {
    const b = this.batch(batchId);
    const now = this.deps.clock.now();
    const today = plainDate(now.slice(0, 10));
    const boarded: BatchLoan[] = [], refused: { loan: BatchLoan; reason: string }[] = [];
    for (const bl of this.batchLoans(batchId)) {
      if (bl.status !== "validated") continue;
      const t = boardingMachine.attempt(bl.status, "board", BOARDING_AGENT, { openHardFailures: this.openHardFailures(bl).length, transferDateReached: today >= b.transfer_date, finalTapeReconciled: opts.finalTapeReconciled, onApprovedList: true });
      if (!t.ok) { refused.push({ loan: bl, reason: t.reason }); continue; }
      const s = bl.staged;
      const regx = regxDaysDelinquent(bl.applied, b.transfer_date);
      const fnmaStatus = fnmaDelinquencyStatus(bl.applied, b.transfer_date);
      const earliestUnpaid = earliestUnpaidDueDate(bl.applied, b.transfer_date);
      bl.regx_days_delinquent_at_boarding = regx;
      bl.fnma_delinquency_status_at_boarding = fnmaStatus;
      bl.default_status_at_boarding = regx > 0 || s.bankruptcy.active || s.foreclosure.active;
      bl.fdcpa_debt_collector_flag = bl.default_status_at_boarding;
      bl.loan_id = this.deps.loanIdFor ? this.deps.loanIdFor(bl) : randomUUID();
      bl.status = "boarded";
      if (s.fnma_loan_number) this.boardedLoanNumbers.add(s.fnma_loan_number);

      const set = this.postOpeningEntries(bl, b.transfer_date);
      const boardedEvent = this.deps.events.append({ type: "loan.boarded", loanId: bl.id, aggregate: { kind: "transfer_batch", id: batchId }, actor: BOARDING_AGENT, payload: {
        batch_loan_id: bl.id, loan_id: bl.loan_id, fnma_loan_number: s.fnma_loan_number, transfer_date: b.transfer_date, boarded_at: now,
        min: s.min, mers_eligible: s.mers_eligible, escrowed: s.escrowed, remittance_type: s.remittance_type,
        regx_days_delinquent: regx, fnma_delinquency_status: fnmaStatus, earliest_unpaid_due_date: earliestUnpaid,
        default_status_at_boarding: bl.default_status_at_boarding, fdcpa_debt_collector_flag: bl.fdcpa_debt_collector_flag,
        bk_active: s.bankruptcy.active, fc_active: s.foreclosure.active, lossmit_in_process: s.lossmit.in_process, scra_active: s.scra.active,
        opening_entry_set_id: set.id, warnings: this.openWarnings(bl).map((v) => v.code),
      } });
      // 11.1 rule 2: transfer-in delinquency is seeded from the transferor's history — one window per unpaid installment.
      for (const inst of bl.applied) if (isUnpaidAsOf(inst, b.transfer_date) && inst.due_date < b.transfer_date) {
        this.deps.events.append({ type: "loan.delinquency.window_opened", loanId: bl.id, actor: BOARDING_AGENT, causationId: boardedEvent.id,
          payload: { due_date: inst.due_date, principal_residence: (s.property.occupancy ?? "unknown") !== "investment", seeded_at_boarding: true } });
      }
      boarded.push(bl);
    }
    return { boarded, refused };
  }

  /** 1.6 opening postings at `loan.boarded`, balanced against `transfer_in_clearing`. */
  private postOpeningEntries(bl: BatchLoan, effectiveDate: PlainDate): EntrySet {
    const s = bl.staged;
    const loanId = bl.loan_id!;
    const clearing = { scope: "custodial" as const, custodialAccountId: this.deps.clearingAccountId, account: "transfer_in_clearing" as const };
    const acct = (account: "principal" | "deferred_principal" | "forborne_principal" | "corporate_advance" | "escrow_advance" | "late_charges" | "escrow" | "suspense_unapplied") => ({ scope: "loan" as const, loanId, account });
    const lines: { account: ReturnType<typeof acct> | typeof clearing; amountCents: bigint; ruleRef: string; memo?: string }[] = [];
    let clearingTotal = 0n;
    const dr = (a: ReturnType<typeof acct>, amt: bigint, ref: string, memo?: string) => { if (amt !== 0n) { lines.push({ account: a, amountCents: amt, ruleRef: ref, ...(memo ? { memo } : {}) }); clearingTotal -= amt; } };
    dr(acct("principal"), s.upb_cents ?? 0n, "1.6:opening:principal");
    dr(acct("deferred_principal"), s.deferred_principal_cents, "1.6:opening:deferred_principal");
    dr(acct("forborne_principal"), s.forborne_principal_cents, "1.6:opening:forborne_principal");
    dr(acct("corporate_advance"), s.corporate_advances_cents, "1.6:opening:corporate_advances");
    dr(acct("late_charges"), s.late_charges_due_cents, "1.6:opening:late_charges_receivable");
    // Escrow: positive balance = liability (Cr); negative = transferor escrow advance receivable (Dr escrow_advances).
    if (s.escrow_balance_cents > 0n) dr(acct("escrow"), -s.escrow_balance_cents, "1.6:opening:escrow_liability");
    else if (s.escrow_balance_cents < 0n) dr(acct("escrow_advance"), -s.escrow_balance_cents, "1.6:opening:escrow_advances_receivable");
    dr(acct("suspense_unapplied"), -s.unapplied_cents, "1.6:opening:suspense_unapplied");
    if (clearingTotal !== 0n) lines.push({ account: clearing, amountCents: clearingTotal, ruleRef: "1.6:opening:clearing" });
    return this.deps.ledger.post({ effectiveDate, description: `opening balances ${s.fnma_loan_number ?? s.transferor_loan_number}`, lines });
  }

  /** Scheduled monthly interest for reports/tests (F-1-09 "30 days' interest on the UPB"). */
  scheduledInterest(bl: BatchLoan): bigint {
    const s = bl.staged;
    if (s.upb_cents === null || !s.note_rate_pct) return 0n;
    return monthlyInterest(s.upb_cents, ratePercent(s.note_rate_pct));
  }

  /** Re-queue an investor event rejected by Fannie Mae (LL-2026-05 EscrowSetup); the timer stays armed. */
  requeueInvestorEvent(rejected: DomainEvent): void {
    this.deps.events.append({ type: "investor_events.queued", ...(rejected.loanId ? { loanId: rejected.loanId } : {}), actor: BOARDING_AGENT, causationId: rejected.id,
      payload: { type: (rejected.payload as { type?: string }).type ?? null, attempt: Number((rejected.payload as { attempt?: number }).attempt ?? 1) + 1 } });
  }
}
