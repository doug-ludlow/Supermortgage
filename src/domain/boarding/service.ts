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
import { fnmaPositionLagDeadline } from "../transfers/reconciliation.ts";
import { inflightBoardingFacts } from "../transfers/ops-1-7.ts";

export const BOARDING_AGENT: Actor = { kind: "agent", id: "boarding" };

export type TapeKind = "preliminary" | "final" | "payment_history" | "escrow_history" | "escrow_analysis" | "lossmit" | "fc_bk" | "images_manifest" | "consents" | "correspondence" | "trial_balance";

export interface Tape { readonly id: string; readonly batch_id: string; readonly kind: TapeKind; readonly sha256: string; readonly row_count: number; readonly received_at: string; }
export interface TapeReceipt { readonly status: "accepted" | "duplicate"; readonly tape_id: string; readonly sha256: string; readonly received_at: string; }

export interface Validation extends RuleResult { readonly id: number; readonly run_id: string; readonly waived?: { by: Actor; reason: string; decision_id: string }; }

export interface BatchLoan {
  readonly id: string;
  readonly batch_id: string;
  /** Canonical row; replaced (never edited in place) by `applyCorrection`, which re-applies the FIFO history. */
  staged: StagedLoan;
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
export type CorrectionResult =
  | { ok: true; fields: readonly (keyof StagedLoan)[]; money_fields: readonly (keyof StagedLoan)[]; decision: AgentDecision; status: BoardingStatus }
  | { ok: false; code: "NOT_FOUND" | "NOT_CORRECTABLE" | "MONEY_FIELD_GUARD" | "EVIDENCE_REQUIRED"; reason: string };

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
    // `transfer_date` rides along for the timers anchored on it (SM_LOSSMIT_FILE_VERIFY_T0 on `transfer.tape.received{kind=lossmit}`).
    const b = this.batches.get(batchId);
    this.deps.events.append({ type: "transfer.tape.received", aggregate: { kind: "transfer_batch", id: batchId }, actor: { kind: "external", id: "transferor_sftp" },
      payload: { kind, tape_id: tape.id, sha256, row_count: rowCount, batch_id: batchId, ...(b ? { transfer_date: b.transfer_date } : {}) } });
    return { status: "accepted", tape_id: tape.id, sha256, received_at: tape.received_at };
  }

  /** `transfer.batch.cutover_completed` (1.1 state machine "cutover (transfer date)"): every staged loan of the batch has boarded or left the list, on or after the transfer date. */
  completeCutover(batchId: string, extra: { respa_effective_date?: PlainDate; code_type?: "D" | "I" | "C" | "none"; notice_mode?: "separate" | "combined"; type?: string; last_batch_for_partner?: boolean } = {}): DomainEvent {
    const b = this.batch(batchId);
    const now = this.deps.clock.now();
    if (plainDate(now.slice(0, 10)) < b.transfer_date) throw new RangeError(`cutover for ${batchId} cannot complete before the transfer date ${b.transfer_date}`);
    const loans = this.batchLoans(batchId);
    const pending = loans.filter((l) => l.status === "staged" || l.status === "validated" || l.status === "exception");
    if (pending.length) throw new RangeError(`${pending.length} loan(s) of ${batchId} are still ${[...new Set(pending.map((l) => l.status))].join("/")}; cutover incomplete`);
    const boarded = loans.filter((l) => l.status === "boarded" || l.status === "reconciled" || l.status === "active").length;
    return this.deps.events.append({ type: "transfer.batch.cutover_completed", aggregate: { kind: "transfer_batch", id: batchId }, actor: BOARDING_AGENT, payload: {
      batch_id: batchId, type: extra.type ?? "master_to_sub", transfer_date: b.transfer_date, respa_effective_date: extra.respa_effective_date ?? b.transfer_date, ted: b.transfer_date, code_type: extra.code_type ?? "none", notice_mode: extra.notice_mode ?? "separate",
      loan_count: loans.length, boarded_count: boarded, withdrawn_count: loans.length - boarded, last_batch_for_partner: extra.last_batch_for_partner ?? false, fnma_position_deadline: fnmaPositionLagDeadline(b.transfer_date), cutover_at: now } });
  }

  // ───────── LL-2026-05 Escrow Setup acknowledgments ("for every escrow category") ─────────
  /** Escrow item category types on the boarded loan (LL-2026-05 "each applicable escrow item category type"), from its escrow lines. */
  static escrowCategoriesOf(s: StagedLoan): string[] {
    const map = (t: string): string => (/tax/i.test(t) ? "tax" : /hazard|homeowner|wind|hail/i.test(t) ? "hazard" : /flood/i.test(t) ? "flood" : /\bmi\b|mortgage_ins|pmi/i.test(t) ? "mi" : "other");
    return s.escrowed ? [...new Set(s.escrow_lines.map((l) => map(l.line_type)))] : [];
  }
  private readonly escrowAcks = new Map<string, Set<string>>();
  /**
   * Fannie Mae's acknowledgment of one Escrow Setup event. The ack is appended as `investor_events.acked{type=EscrowSetup, category}`;
   * the one that completes the loan's category set carries `every_category=true`, which is what LL_2026_05_ESCROW_SETUP_ACQUIRED_BD1 waits for.
   */
  recordEscrowSetupAck(batchLoanId: string, category: string, ackedAt: string = this.deps.clock.now()): { acked: string[]; expected: string[]; every_category: boolean; event: DomainEvent } {
    const bl = this.batchLoan(batchLoanId);
    const expected = BoardingService.escrowCategoriesOf(bl.staged);
    let acked = this.escrowAcks.get(batchLoanId); if (!acked) { acked = new Set(); this.escrowAcks.set(batchLoanId, acked); }
    acked.add(category);
    const every = expected.length > 0 && expected.every((c) => acked!.has(c));
    const event = this.deps.events.append({ type: "investor_events.acked", loanId: bl.id, actor: { kind: "external", id: "fnma" }, occurredAt: ackedAt,
      payload: { type: "EscrowSetup", category, acked_categories: [...acked], expected_categories: expected, every_category: every, loan_id: bl.loan_id ?? null } });
    return { acked: [...acked], expected, every_category: every, event };
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
  /** Run the gate over the batch (or `only` these batch-loan ids, after a correction). A hard failure raises `loan.boarding_exception.raised{severity=hard}` once — the nightly re-run does not re-raise an open one, so SM_BOARD_EXCEPTION_SLA_2 keeps its first `raised_at`. */
  validate(batchId: string, only?: ReadonlySet<string>): Scorecard {
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
      if (only && !only.has(bl.id)) continue;
      const prevWaived = new Map(bl.validations.filter((v) => v.waived).map((v) => [v.code, v.waived!]));
      const prevOpenHard = new Set(this.openHardFailures(bl).map((v) => v.code));
      const results = runRules({ loan: bl.staged, batch: b, ext: this.deps.ext, batchCounts: { loanNumbers, mins } }, ALL_RULES);
      const ruleCodes = new Set(results.map((r) => r.code));
      const raisedByAgent = bl.validations.filter((v) => !ruleCodes.has(v.code));   // `raiseException` rows are not the rule set's to clear
      bl.validations = [...results.map((r) => {
        const w = prevWaived.get(r.code);
        return { ...r, id: ++this.validationSeq, run_id, ...(w ? { waived: w } : {}) };
      }), ...raisedByAgent];
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
        for (const v of openHard) if (!prevOpenHard.has(v.code)) this.deps.events.append({ type: "loan.boarding_exception.raised", loanId: bl.id, aggregate: { kind: "transfer_batch", id: batchId }, actor: BOARDING_AGENT,
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

  /** 1.5 rule 2 / W-016: warnings the partner (not the transferor) corrects go to the partner as a query; boarding proceeds. */
  partnerQuery(batchLoanId: string): TransferorQuery {
    const bl = this.batchLoan(batchLoanId);
    return { batch_loan_id: bl.id, transferor_loan_number: bl.staged.transferor_loan_number, fnma_loan_number: bl.staged.fnma_loan_number,
      items: this.openWarnings(bl).filter((v) => v.code === "W-016").map((v) => ({ rule_code: v.code, message: v.message ?? "", expected: v.expected, actual: v.actual, money_field: v.money_field })) };
  }

  // ───────── corrections and agent-raised exceptions (1.1 agent design: applyCorrection / raiseException) ─────────
  /** Money fields (UPB, escrow, suspense, advances, fees, P&I, rate; HF-016 non-interest-bearing balances) — never agent-corrected. */
  static readonly MONEY_FIELDS: readonly (keyof StagedLoan)[] = ["upb_cents", "scheduled_upb_cents", "original_upb_cents", "escrow_balance_cents", "escrow_payment_cents", "escrow_lines",
    "unapplied_cents", "corporate_advances_cents", "fees_advances_cents", "late_charges_due_cents", "late_charge_pct", "pi_cents", "note_rate_pct", "deferred_principal_cents", "forborne_principal_cents"];
  /**
   * Apply a correction to the canonical row and re-run the gate on the loan. Guardrails (1.1 agent design): money fields are
   * "never agent-corrected — only transferor-corrected or `officer`-waived": a money change needs `provenance="transferor"`
   * with the correction file/letter as evidence, whoever keys it; an officer resolves a money discrepancy by `proposeWaiver`.
   * Non-money fields (formatting, enumerations, derived fields) are the agent's to correct, with a decision record. The row
   * is replaced, never edited; a loan already boarded is corrected as a new `loan_terms` version / ledger reversal (edge cases), not here.
   */
  applyCorrection(batchLoanId: string, changes: Partial<StagedLoan>, actor: Actor, opts: { provenance: "transferor" | "agent"; evidence_document_ids?: readonly string[]; rationale?: string; confidence?: number | null; rule_code?: string }): CorrectionResult {
    const bl = this.loans.get(batchLoanId);
    if (!bl) return { ok: false, code: "NOT_FOUND", reason: `no batch loan ${batchLoanId}` };
    const fields = Object.keys(changes) as (keyof StagedLoan)[];
    if (!fields.length) throw new RangeError("applyCorrection needs at least one changed field");
    if (bl.status !== "staged" && bl.status !== "validated" && bl.status !== "exception") return { ok: false, code: "NOT_CORRECTABLE", reason: `loan is ${bl.status}: post-boarding corrections are a new loan_terms version or ledger reversal entries, never a tape edit` };
    const money = fields.filter((f) => (BoardingService.MONEY_FIELDS as readonly string[]).includes(f));
    const evidence = [...(opts.evidence_document_ids ?? [])];
    if (money.length && opts.provenance !== "transferor") return { ok: false, code: "MONEY_FIELD_GUARD", reason: `${money.join(", ")}: money fields are never agent-corrected — only transferor-corrected (provenance=transferor with the correction file) or officer-waived (proposeWaiver)` };
    if (opts.provenance === "transferor" && !evidence.length) return { ok: false, code: "EVIDENCE_REQUIRED", reason: "a transferor correction cites its correction file / letter (evidence_document_ids); the agent cannot assert provenance for it" };
    const staged: StagedLoan = { ...bl.staged, ...changes };
    const decision: AgentDecision = { id: randomUUID(), agent: actor.kind === "agent" ? actor.id : "boarding", batch_loan_id: bl.id, rule_code: opts.rule_code ?? "", action: opts.provenance === "transferor" ? "transferor_corrected" : "agent_corrected",
      evidence_document_ids: evidence, confidence: opts.confidence ?? null, rule_set_version: RULE_SET_VERSION, model_version: null, prompt_version: null, rationale: opts.rationale ?? `${fields.join(", ")} corrected (${opts.provenance})`,
      ...(actor.kind === "human" ? { approved_by: actor.id, approved_role: actor.role ?? "" } : {}), created_at: this.deps.clock.now() };
    this.decisions.push(decision);
    bl.staged = staged;
    bl.applied = applyFifo(staged.installments, staged.payments).installments;
    // A correction that cites the agent-raised exception it cures closes that row (the rule set cannot re-check it).
    if (opts.rule_code) bl.validations = bl.validations.map((v) => (v.code === opts.rule_code && !ALL_RULES.some((r) => r.code === v.code) ? { ...v, result: "pass" as const, message: `corrected: ${decision.rationale}` } : v));
    this.deps.events.append({ type: "boarding.correction.applied", loanId: bl.id, aggregate: { kind: "transfer_batch", id: bl.batch_id }, actor,
      payload: { batch_loan_id: bl.id, fields, money_fields: money, provenance: opts.provenance, evidence_document_ids: evidence, decision_id: decision.id, rule_code: opts.rule_code ?? null } });
    this.validate(bl.batch_id, new Set([bl.id]));
    return { ok: true, fields, money_fields: money, decision, status: bl.status };
  }

  /**
   * The agent's own exception — a defect the rule set cannot see (document review, transferor correspondence). Recorded as a
   * validation row; a `hard` one moves a `staged`/`validated` loan to `exception` and its event arms SM_BOARD_EXCEPTION_SLA_2
   * (`loan.boarding_exception.raised{severity=hard}`, anchored on `raised_at`). Cleared by `applyCorrection(rule_code)` or a waiver.
   */
  raiseException(batchLoanId: string, x: { rule_code: string; severity: "hard" | "warning" | "info"; money_field?: boolean; message?: string; expected?: unknown; actual?: unknown; evidence_document_ids?: readonly string[] }, actor: Actor): { validation: Validation; status: BoardingStatus; event: DomainEvent } {
    const bl = this.batchLoan(batchLoanId);
    if (!x.rule_code) throw new RangeError("raiseException needs rule_code");
    if (x.severity === "hard" && bl.status !== "staged" && bl.status !== "validated" && bl.status !== "exception") throw new RangeError(`a hard exception cannot be raised on a ${bl.status} loan`);
    const run_id = randomUUID();
    const validation: Validation = { id: ++this.validationSeq, run_id, code: x.rule_code, severity: x.severity, result: "fail", money_field: x.money_field ?? false,
      ...(x.message ? { message: x.message } : {}), ...(x.expected !== undefined ? { expected: x.expected } : {}), ...(x.actual !== undefined ? { actual: x.actual } : {}) };
    const already = bl.validations.some((v) => v.code === x.rule_code && v.severity === "hard" && v.result === "fail" && !v.waived);
    bl.validations = [...bl.validations.filter((v) => v.code !== x.rule_code), validation];
    if (x.severity === "hard" && bl.status !== "exception") {
      const t = boardingMachine.attempt(bl.status, "validate", actor, { openHardFailures: this.openHardFailures(bl).length, transferDateReached: false, finalTapeReconciled: false, onApprovedList: true });
      if (t.ok) bl.status = t.to;
    }
    const raised_at = this.deps.clock.now();
    const event = already
      ? this.deps.events.append({ type: "loan.boarding_exception.updated", loanId: bl.id, aggregate: { kind: "transfer_batch", id: bl.batch_id }, actor, payload: { batch_loan_id: bl.id, rule_code: x.rule_code, severity: x.severity, run_id } })
      : this.deps.events.append({ type: "loan.boarding_exception.raised", loanId: bl.id, aggregate: { kind: "transfer_batch", id: bl.batch_id }, actor,
          payload: { batch_loan_id: bl.id, rule_code: x.rule_code, severity: x.severity, money_field: validation.money_field, raised_at, run_id, expected: x.expected ?? null, actual: x.actual ?? null, raised_by: `${actor.kind}:${actor.id}`, evidence_document_ids: [...(x.evidence_document_ids ?? [])] } });
    return { validation, status: bl.status, event };
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
        bk_active: s.bankruptcy.active, fc_active: s.foreclosure.active, scra_active: s.scra.active,               // lossmit_in_process rides with the 1.7 facts below
        opening_entry_set_id: set.id, warnings: this.openWarnings(bl).map((v) => v.code),
        // 1.7: the inherited loss-mit facts the §1024.41(k) clocks arm on (ack period, completeness, offer, appeal window, forbearance, SMDU case).
        ...inflightBoardingFacts(s.lossmit, b.transfer_date),
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
