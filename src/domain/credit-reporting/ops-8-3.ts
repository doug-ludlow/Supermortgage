/**
 * §8.3 process-owned operations — the credit-reporting overlay engine ("Credit-reporting overlays, suppressions and
 * status flags", spec 8.3 Verified requirement) over the 8.1 cycle mechanics in ./ops.ts and the pure overlays in
 * ./suppression.ts. These are the code paths that append the 8.3 events the registry rows arm on and are satisfied by:
 *
 *   metro2.snapshot.built{cycle_id, as_of, evaluated_on, mechanism, cii_applied, ecoa_x_applied, ecoa_x_party_ids}
 *     — `OverlayRunner.build`: one per loan the cycle carries after every overlay *mechanism* was applied at
 *       build/transmission time (`applyOverlayMechanisms` through `CycleRecordInput.overlay`, the 8.1 generator's
 *       overlay hook); satisfies SM_CR_DECEASED_ECOA_X_NEXT_CYCLE ("snapshot carries ECOA X").
 *   borrower.deceased.confirmed{party_id, confirmation, evidence_kind, evidence_document_id}
 *     — `OverlayRunner.confirmDeceased`: the 4.4 confirmation record (death certificate / SSA / obituary evidence)
 *       validated and appended (SM_CR_DECEASED_ECOA_X_NEXT_CYCLE trigger, anchor `confirmation`), with the `deceased`
 *       suppression (ECOA `X` on that consumer's segment from the next cycle — rule 6).
 *   credit.noe_bar.expired{case_id, reason, is_qwr, ends_on} — `OverlayRunner.expireNoeBars`: the transmission-time
 *       sweep that expires the §1024.35(i)(1) / RESPA §6(e)(3) 60-day bars (RESPA_2605E3_QWR_SUPPRESS_60 "expiry";
 *       a Reg X bar also gets 4.1's `credit_reporting.suppression.expired` so REGX_1024_35I_CREDIT_SUPPRESS_60 closes).
 *   credit.suppression.created / credit.suppression.reviewed — every suppression this process books
 *       (`ingestNoeOpened`, `confirmDeceased`, `ingestBlockNotice`) and the 30-day review (`reviewSuppression`,
 *       SM_CR_SUPPRESSION_REVIEW_30 "review recorded"; a stale row escalates `human_agent`).
 *   credit.block.notice.received / credit.overlay.urgent{kind=identity_theft_block} / case.fraud.opened
 *       — `ingestBlockNotice`: the e-OSCAR Block notification (rule 7): omit immediately, AUD within 2 BD
 *       (SM_CR_OVERLAY_URGENT_AUD_BD2), fraud case; FCRA_1681C2_IDTHEFT_BLOCK_GATE arms on the receipt.
 *   credit.courtesy_request.logged — `logCourtesyRequest`: a "please don't report me" request is logged and answered
 *       with the direct-dispute process, never a suppression (guardrail; 8.3-T12).
 *   credit.overlay.held_for_officer — a new adverse status for a servicemember during the §3919 gate is held
 *       (omitted from the file) for `officer` review with the "not solely by reason of the relief" rationale (rule 4).
 *
 * bigint cents; PlainDate; every input validated (RangeError) before anything is appended; rows are append-only
 * versions in the record store (`credit_reporting_suppressions` — the 8.3 authoritative schema, db/migrations/0010).
 */
import { type PlainDate, addDays, addMonths, endOfMonth, startOfMonth } from "../../kernel/calendar/date.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { AppliedInstallment } from "../boarding/delinquency.ts";
import { toPrior } from "./metro2.ts";
import { buildCycle, requireOfficer, type BureauConfig, type CreditCycleRunner, type CycleBuild, type CycleRecordInput } from "./ops.ts";
import {
  applyNoeBar, noeBarApplies, noeBarEnd, bankruptcyOverlay, scraOverlay, disasterOverlay, deceasedOverlay, identityTheftResponse, courtesyRequest,
  staleSuppressionReviewDue, type NoeBar, type BankruptcyState, type ScraCase, type Suppression, type Mechanism, type IdentityTheftResponse,
} from "./suppression.ts";
import { staleSuppressionReview } from "./ops.ts";
import type { Bureau } from "./disputes.ts";
import type { AccountStatus, Metro2Snapshot, PriorHistory } from "./types.ts";

const isDate = (v: unknown): v is PlainDate => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const need = (v: unknown, what: string): void => { if (v === undefined || v === null || v === "" || v === false) throw new RangeError(`${what} is required`); };
/** ISO instant → its Eastern-time civil date (the platform's cut-off convention), or a PlainDate as is. */
const etDate = (v: string): PlainDate => (isDate(v) ? v : wallClock(Date.parse(v), "America/New_York").date);

export const SUPPRESSIONS = "credit_reporting_suppressions";
export const COURTESY_REQUESTS = "credit_courtesy_requests";
/** §1024.35(i)(1) / 12 U.S.C. §2605(e)(3): 60 calendar days after receipt. */
export const NOE_BAR_DAYS = 60;
/** The 8.3 data-model reasons that are a NoE/QWR 60-day bar. */
export const NOE_BAR_REASONS: ReadonlySet<string> = new Set(["regx_1024_35_i", "respa_6e3_qwr", "noe_bar"]);
/** 4.4 evidence that confirms a death (rule 6: "death certificate/SSA/obituary evidence per 4.4"). */
export const DECEASED_EVIDENCE_KINDS = ["death_certificate", "ssa_death_master_file", "obituary"] as const;
export type DeceasedEvidenceKind = (typeof DECEASED_EVIDENCE_KINDS)[number];
/** SM_CR_SUPPRESSION_REVIEW_30: every 30 calendar days while active. */
export const SUPPRESSION_REVIEW_DAYS = 30;
const BUREAUS: ReadonlySet<string> = new Set(["equifax", "experian", "transunion", "innovis"]);
/** What the AI voice agent tells the borrower instead (8.3 guardrail: "the request is logged and answered"). */
export const COURTESY_RESPONSE = "direct_dispute_process_explained";
export const COURTESY_SCRIPT = "We report payment history accurately and cannot leave a late payment off your credit report on request. If you believe the information we furnish is inaccurate you may dispute it directly with us in writing at our designated dispute address, or with the credit bureaus; we will investigate and correct anything we find to be inaccurate.";

// ---------------------------------------------------------------------------
// Record store (the ToolRuntime's EntityStore satisfies this structurally; MemoryRecords for domain tests)
// ---------------------------------------------------------------------------
export interface StoredRecord { readonly id: string; readonly data: Record<string, unknown>; }
export interface RecordStore {
  get(kind: string, id: string): StoredRecord | undefined;
  list(kind: string, where?: (d: Record<string, unknown>) => boolean): readonly StoredRecord[];
  put(kind: string, id: string, data: Record<string, unknown>, by: Actor, now: string): StoredRecord;
}
export class MemoryRecords implements RecordStore {
  private readonly rows = new Map<string, StoredRecord>();
  get(kind: string, id: string): StoredRecord | undefined { return this.rows.get(`${kind} ${id}`); }
  list(kind: string, where: (d: Record<string, unknown>) => boolean = () => true): readonly StoredRecord[] {
    return [...this.rows.entries()].filter(([k, r]) => k.startsWith(`${kind} `) && where(r.data)).map(([, r]) => r);
  }
  put(kind: string, id: string, data: Record<string, unknown>, by: Actor, now: string): StoredRecord {
    const prev = this.get(kind, id);
    const rec = { id, data: { ...(prev?.data ?? {}), ...data, updated_at: now, updated_by: `${by.kind}:${by.id}` } };
    this.rows.set(`${kind} ${id}`, rec); return rec;
  }
}
export interface EscalationPort { open(input: { kind: "officer" | "human_agent"; loanId?: string; caseId?: string; payload?: Record<string, unknown> }, by: Actor): unknown; }

// ---------------------------------------------------------------------------
// Overlay mechanisms on a snapshot (rule 1 NoE bar, rule 3 bankruptcy, rule 4 SCRA, rule 5 disaster, rule 6 deceased)
// ---------------------------------------------------------------------------
export interface OverlayContext {
  /** The FIFO-applied ledger the snapshot was derived from (as-if-paid projection / post-petition performance). */
  readonly installments: readonly AppliedInstallment[];
  readonly prior: PriorHistory | Metro2Snapshot | null;
  readonly noe_bars?: readonly NoeBar[];
  readonly bankruptcy?: BankruptcyState | null;
  readonly scra?: ScraCase | null;
  readonly disaster?: { readonly declared_on: PlainDate; readonly extended_to?: PlainDate | null } | null;
  readonly deceased_party_ids?: readonly string[];
}
export interface OverlayOutcome {
  readonly snapshot: Metro2Snapshot;
  /** Trail of the mechanisms applied, lowest priority first. */
  readonly applied: readonly string[];
  readonly cii_applied: boolean;
  readonly ecoa_x_applied: boolean;
  readonly ecoa_x_party_ids: readonly string[];
  /** Rule 4: a *new* adverse status for the servicemember during the §3919 gate — held for `officer` review before furnishing. */
  readonly held_for_officer: { readonly party_id: string; readonly status: AccountStatus; readonly prior_status: AccountStatus | null } | null;
}
/**
 * Apply every active overlay mechanism to the 8.1 snapshot as of the evaluation (transmission) date. Lower-priority
 * mechanisms run first so a higher-priority one applied later owns the status/APD/DOFD fields (MECHANISM_PRIORITY:
 * freeze_status > as_if_paid_projection > flag_only); codes co-exist (CII + XB + ECOA X, 8.3-T14).
 */
export function applyOverlayMechanisms(s: Metro2Snapshot, ctx: OverlayContext, evaluatedOn: PlainDate): OverlayOutcome {
  if (!isDate(evaluatedOn)) throw new RangeError("evaluated_on is required (PlainDate)");
  let out = s; const applied: string[] = [];
  for (const bar of ctx.noe_bars ?? []) {
    if (!isDate(bar.received_on)) throw new RangeError("noe bar received_on is required (PlainDate)");
    out = applyNoeBar(out, ctx.installments, bar, evaluatedOn, ctx.prior);
    applied.push(noeBarApplies(bar, evaluatedOn) ? `noe_bar:as_if_paid_projection:${bar.scope.join(",")}` : `noe_bar:expired:${noeBarEnd(bar.received_on)}`);
  }
  let held: OverlayOutcome["held_for_officer"] = null;
  if (ctx.scra) {
    const r = scraOverlay(out, ctx.scra, ctx.prior);
    if (r.held_for_officer) held = { party_id: ctx.scra.party_id, status: r.snapshot.account_status, prior_status: toPrior(ctx.prior)?.status ?? null };
    out = r.snapshot; applied.push(ctx.scra.stay_granted ? "scra:freeze_status" : "scra:reduced_payment");
  }
  if (ctx.bankruptcy) { out = bankruptcyOverlay(out, ctx.bankruptcy, ctx.installments, ctx.prior); applied.push(`bankruptcy:${ctx.bankruptcy.phase.phase}`); }
  if (ctx.disaster) { const before = out.special_comment; out = disasterOverlay(out, ctx.disaster.declared_on, ctx.disaster.extended_to ?? null); applied.push(out.special_comment === "AW" ? "disaster:AW" : `disaster:yields_to_${before || "expiry"}`); }
  const ecoaX: string[] = [];
  for (const p of ctx.deceased_party_ids ?? []) if (out.consumers.some((c) => c.party_id === p)) { out = deceasedOverlay(out, p); ecoaX.push(p); applied.push(`deceased:ECOA X:${p}`); }
  return { snapshot: out, applied, cii_applied: out.consumers.some((c) => c.cii !== ""), ecoa_x_applied: ecoaX.length > 0, ecoa_x_party_ids: ecoaX, held_for_officer: held };
}
/** The 8.1 generator's overlay hook (`CycleRecordInput.overlay`): mechanisms re-evaluated at build and at transmission. */
export const overlayHook = (ctx: OverlayContext): NonNullable<CycleRecordInput["overlay"]> => (s, on) => applyOverlayMechanisms(s, ctx, on).snapshot;

// ---------------------------------------------------------------------------
// Rows → domain shapes
// ---------------------------------------------------------------------------
const rowSuppression = (r: StoredRecord): Suppression => {
  const d = r.data;
  return { reason: String(d.reason) as Suppression["reason"], mechanism: String(d.mechanism) as Mechanism, party_id: (d.party_id as string | null | undefined) ?? null,
    starts_on: String(d.starts_on) as PlainDate, ends_on: isDate(d.ends_on) ? d.ends_on : null, codes: Array.isArray(d.codes) ? (d.codes as string[]) : [], ...(Array.isArray(d.scope) ? { scope: d.scope as PlainDate[] } : {}) };
};
/** The NoE bar an active NoE/QWR suppression row is (scope `all` → every installment unpaid on the receipt date). */
export function noeBarOf(row: StoredRecord, installments: readonly AppliedInstallment[]): NoeBar {
  const d = row.data; const received = String(d.starts_on) as PlainDate;
  const scope: PlainDate[] = Array.isArray(d.scope) ? (d.scope as PlainDate[]) : installments.filter((i) => i.due_date <= received && (i.satisfied_on === null || i.satisfied_on > received)).map((i) => i.due_date);
  return { received_on: received, scope, closed_on: isDate(d.closed_on) ? d.closed_on : null, outcome: (d.outcome as NoeBar["outcome"]) ?? null, continuing_disagreement: d.continuing_disagreement === true };
}

export interface OverlayRecordInput extends CycleRecordInput { readonly overlay_context?: OverlayContext; }
export interface OverlayBuild extends CycleBuild {
  readonly held_for_officer: readonly { loan_id: string; party_id: string; status: AccountStatus; prior_status: AccountStatus | null }[];
  readonly outcomes: ReadonlyMap<string, OverlayOutcome>;
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------
export interface OverlayRunnerDeps { readonly events: EventStore; readonly actor: Actor; readonly store?: RecordStore; readonly escalations?: EscalationPort; readonly now?: () => string; }

export class OverlayRunner {
  private readonly events: EventStore; private readonly actor: Actor; readonly store: RecordStore; private readonly escalations: EscalationPort | null; private readonly clock: () => string;
  constructor(deps: OverlayRunnerDeps) {
    this.events = deps.events; this.actor = deps.actor; this.store = deps.store ?? new MemoryRecords(); this.escalations = deps.escalations ?? null;
    this.clock = deps.now ?? (() => new Date().toISOString());
  }
  private now(): string { return this.clock(); }

  // ---- read models over the rows --------------------------------------------
  /** Active suppressions for a loan (whole-loan rows have `loan_id`; the `suppressions` input `buildCycle` resolves). */
  activeSuppressions(loanId: string): Suppression[] {
    return this.store.list(SUPPRESSIONS, (d) => d.loan_id === loanId && d.status === "active").map(rowSuppression);
  }
  noeBars(loanId: string, installments: readonly AppliedInstallment[]): NoeBar[] {
    return this.store.list(SUPPRESSIONS, (d) => d.loan_id === loanId && d.status !== "released" && NOE_BAR_REASONS.has(String(d.reason))).map((r) => noeBarOf(r, installments));
  }
  deceasedPartyIds(loanId: string): string[] {
    return this.store.list(SUPPRESSIONS, (d) => d.loan_id === loanId && d.status === "active" && d.reason === "deceased" && typeof d.party_id === "string").map((r) => String(r.data.party_id));
  }

  // ---- the cycle with every mechanism applied (8.1 Integrations: "evaluated at build and re-evaluated at transmission") ----
  build(f: { cycle_id: string; as_of: PlainDate; evaluated_on?: PlainDate; records: readonly OverlayRecordInput[]; config: Record<Bureau, BureauConfig>; runner?: CreditCycleRunner }): OverlayBuild {
    need(f.cycle_id, "cycle_id"); if (!isDate(f.as_of)) throw new RangeError("as_of is required (PlainDate)");
    const on = f.evaluated_on ?? f.as_of;
    const outcomes = new Map<string, OverlayOutcome>(); const held: { loan_id: string; party_id: string; status: AccountStatus; prior_status: AccountStatus | null }[] = []; const records: CycleRecordInput[] = [];
    for (const r of f.records) {
      const { overlay_context: ctx, ...rest } = r;
      if (!ctx) { records.push(rest); continue; }
      const o = applyOverlayMechanisms(r.snapshot, ctx, on);
      outcomes.set(r.snapshot.loan_id, o);
      if (o.held_for_officer) {
        // rule 4 / T6: the adverse change is not furnished until an `officer` documents "not solely by reason of the relief"
        held.push({ loan_id: r.snapshot.loan_id, ...o.held_for_officer });
        this.events.append({ type: "credit.overlay.held_for_officer", loanId: r.snapshot.loan_id, actor: this.actor, payload: { cycle_id: f.cycle_id, as_of: f.as_of, party_id: o.held_for_officer.party_id, status: o.held_for_officer.status, prior_status: o.held_for_officer.prior_status, reason: "scra_3919_new_adverse_status", rationale_required: "not solely by reason of the relief (50 U.S.C. 3919)", omitted_from_file: true } });
        this.escalations?.open({ kind: "officer", loanId: r.snapshot.loan_id, payload: { task: "scra_adverse_status_review", cycle_id: f.cycle_id, party_id: o.held_for_officer.party_id, status: o.held_for_officer.status, prior_status: o.held_for_officer.prior_status, rationale_required: "not solely by reason of the relief" } }, this.actor);
        continue;
      }
      records.push({ ...rest, overlay: overlayHook(ctx) });
    }
    const args = { cycle_id: f.cycle_id, as_of: f.as_of, records, config: f.config, evaluated_on: on };
    const b = f.runner ? f.runner.build(args) : buildCycle(args);
    const decisionOf = new Map(b.overlay_decisions.map((d) => [d.loan_id, d] as const));
    for (const s of b.included) {
      const o = outcomes.get(s.loan_id); const d = decisionOf.get(s.loan_id);
      this.events.append({ type: "metro2.snapshot.built", loanId: s.loan_id, actor: this.actor, payload: {
        cycle_id: f.cycle_id, as_of: f.as_of, evaluated_on: on, account_status: s.account_status, mechanism: d?.mechanism ?? "report", reasons: [...(d?.reasons ?? [])],
        cii_applied: o?.cii_applied ?? s.consumers.some((c) => c.cii !== ""), cii_by_party: Object.fromEntries(s.consumers.filter((c) => c.cii !== "").map((c) => [c.party_id, c.cii])),
        ecoa_x_applied: o?.ecoa_x_applied ?? s.consumers.some((c) => c.ecoa === "X"), ecoa_x_party_ids: [...(o?.ecoa_x_party_ids ?? s.consumers.filter((c) => c.ecoa === "X").map((c) => c.party_id))],
        applied: [...(o?.applied ?? [])] } });
    }
    const omitted = [...b.omitted, ...held.map((h) => ({ loan_id: h.loan_id, reason: `scra_adverse_held_for_officer:${h.party_id}` }))];
    return { ...b, omitted, held_for_officer: held, outcomes };
  }

  // ---- rule 1: the NoE / QWR 60-day bar --------------------------------------
  /**
   * 4.1's `case.noe.opened` (payment-related, or flagged `is_qwr=true`) books the scoped bar: `as_if_paid_projection`
   * + XB from receipt through receipt + 60 calendar days (`respa_6e3_qwr` for a QWR, else `regx_1024_35_i`).
   * Returns null when the notice touches no payment (the bar concerns "any payment that is the subject of the notice").
   */
  ingestNoeOpened(e: DomainEvent, opts: { scope?: readonly PlainDate[] } = {}): { suppression_id: string; reason: "regx_1024_35_i" | "respa_6e3_qwr"; bar: NoeBar; ends_on: PlainDate; event_id: string } | null {
    if (e.type !== "case.noe.opened") throw new RangeError(`ingestNoeOpened: unexpected ${e.type}`);
    need(e.loanId, "case.noe.opened.loanId");
    const loanId = String(e.loanId);
    const p = e.payload; const caseId = String(p.case_id ?? ""); need(caseId, "case_id");
    const receipt = p.receipt_date; if (!isDate(receipt)) throw new RangeError("receipt_date is required (PlainDate)");
    const isQwr = p.is_qwr === true;
    if (!isQwr && p.payment_related !== true) return null;
    const reason = isQwr ? "respa_6e3_qwr" : "regx_1024_35_i";
    const scope = opts.scope ?? (Array.isArray(p.scope) && (p.scope as unknown[]).every(isDate) ? (p.scope as PlainDate[]) : null);
    const endsOn = addDays(receipt, NOE_BAR_DAYS);
    const id = `sup-noe-${caseId}${isQwr ? "-qwr" : ""}`;
    const now = this.now();
    this.store.put(SUPPRESSIONS, id, { loan_id: loanId, case_id: caseId, reason, mechanism: "as_if_paid_projection", codes: ["XB"], party_id: null, scope: scope ?? "all", starts_on: receipt, ends_on: endsOn, status: "active", is_qwr: isQwr, trigger_event_id: e.id, evidence_document_id: String(p.document_id ?? caseId), created_by: `${this.actor.kind}:${this.actor.id}`, created_at: now }, this.actor, now);
    const ev = this.events.append({ type: "credit.suppression.created", loanId, actor: this.actor, payload: { id, reason, mechanism: "as_if_paid_projection", party_id: null, case_id: caseId, is_qwr: isQwr, scope: scope ?? "all", starts_on: receipt, ends_on: endsOn, created_at: now, trigger_event_id: e.id, evidence_document_id: String(p.document_id ?? caseId) } });
    return { suppression_id: id, reason, bar: { received_on: receipt, scope: scope ?? [], closed_on: null, outcome: null }, ends_on: endsOn, event_id: ev.id };
  }
  /** 4.1's closure (`case.noe.closed`): the bar keeps its end date; the outcome decides the closing CCC (XR / XH / XC) once the bar has run. */
  noeClosed(f: { suppression_id: string; closed_on: PlainDate; outcome: "error_found" | "no_error"; continuing_disagreement?: boolean }): StoredRecord {
    const row = this.store.get(SUPPRESSIONS, f.suppression_id); if (!row) throw new RangeError(`no suppression ${f.suppression_id}`);
    if (!isDate(f.closed_on)) throw new RangeError("closed_on is required (PlainDate)");
    if (f.outcome !== "error_found" && f.outcome !== "no_error") throw new RangeError("outcome must be error_found or no_error");
    const now = this.now();
    const rec = this.store.put(SUPPRESSIONS, row.id, { closed_on: f.closed_on, outcome: f.outcome, continuing_disagreement: f.continuing_disagreement === true }, this.actor, now);
    this.events.append({ type: "credit.noe_bar.closed", loanId: String(row.data.loan_id), actor: this.actor, payload: { id: row.id, case_id: row.data.case_id ?? null, closed_on: f.closed_on, outcome: f.outcome, ccc_after_bar: f.outcome === "error_found" ? "XR" : f.continuing_disagreement ? "XC" : "XH" } });
    return rec;
  }
  /**
   * The transmission-time sweep (the bar "concerns furnishing"): every active NoE/QWR bar whose 60 days have run by
   * `today` expires — `credit.noe_bar.expired{is_qwr}` (RESPA_2605E3_QWR_SUPPRESS_60 "expiry") and, for a Reg X bar,
   * 4.1's `credit_reporting.suppression.expired` so its REGX_1024_35I_CREDIT_SUPPRESS_60 instance closes on the same sweep.
   */
  expireNoeBars(today: PlainDate): { id: string; loan_id: string; case_id: string | null; reason: string; is_qwr: boolean; ends_on: PlainDate }[] {
    if (!isDate(today)) throw new RangeError("today is required (PlainDate)");
    const out: { id: string; loan_id: string; case_id: string | null; reason: string; is_qwr: boolean; ends_on: PlainDate }[] = [];
    const now = this.now();
    for (const r of this.store.list(SUPPRESSIONS, (d) => d.status === "active" && NOE_BAR_REASONS.has(String(d.reason)) && isDate(d.ends_on) && d.ends_on < today)) {
      const loanId = String(r.data.loan_id); const endsOn = r.data.ends_on as PlainDate; const isQwr = r.data.is_qwr === true || r.data.reason === "respa_6e3_qwr"; const caseId = typeof r.data.case_id === "string" ? r.data.case_id : null;
      this.store.put(SUPPRESSIONS, r.id, { status: "expired", expired_on: today }, this.actor, now);
      this.events.append({ type: "credit.noe_bar.expired", loanId, actor: this.actor, payload: { id: r.id, case_id: caseId, reason: String(r.data.reason), is_qwr: isQwr, ends_on: endsOn, expired_on: today, mechanism_released: String(r.data.mechanism), ccc_after_bar: r.data.outcome === "error_found" ? "XR" : r.data.outcome === "no_error" ? (r.data.continuing_disagreement === true ? "XC" : "XH") : "XB" } });
      if (r.data.reason === "regx_1024_35_i" && caseId) this.events.append({ type: "credit_reporting.suppression.expired", loanId, actor: this.actor, payload: { case_id: caseId, ends_at: endsOn, reason: "regx_1024_35_i" } });
      out.push({ id: r.id, loan_id: loanId, case_id: caseId, reason: String(r.data.reason), is_qwr: isQwr, ends_on: endsOn });
    }
    return out;
  }

  // ---- rule 6: deceased (4.4 confirmation → ECOA X from the next cycle) -------
  confirmDeceased(f: { loan_id: string; party_id: string; confirmed_on: PlainDate; evidence_kind: DeceasedEvidenceKind; evidence_document_id: string; source?: string; trigger_event_id?: string }): { event_id: string; suppression_id: string; ecoa_x_from_cycle_as_of: PlainDate; next_cycle_snapshot_on: PlainDate } {
    need(f.loan_id, "loan_id"); need(f.party_id, "party_id"); need(f.evidence_document_id, "evidence_document_id");
    if (!isDate(f.confirmed_on)) throw new RangeError("confirmed_on is required (PlainDate)");
    if (!(DECEASED_EVIDENCE_KINDS as readonly string[]).includes(f.evidence_kind)) throw new RangeError(`evidence_kind must be one of ${DECEASED_EVIDENCE_KINDS.join(", ")} (4.4 evidence)`);
    const borrowers = this.store.list("borrowers", (d) => d.loan_id === f.loan_id);
    if (borrowers.length && !borrowers.some((b) => b.id === f.party_id && b.data.successor_in_interest !== true)) throw new RangeError(`${f.party_id} is not an obligor on ${f.loan_id} (a confirmed successor is never furnished, so never marked deceased)`);
    const cycleAsOf = endOfMonth(f.confirmed_on); const nextSnapshotOn = addDays(cycleAsOf, 1);
    const ev = this.events.append({ type: "borrower.deceased.confirmed", loanId: f.loan_id, actor: this.actor, payload: { party_id: f.party_id, confirmation: f.confirmed_on, confirmed_on: f.confirmed_on, evidence_kind: f.evidence_kind, evidence_document_id: f.evidence_document_id, source: f.source ?? "4.4", ecoa_x_from_cycle_as_of: cycleAsOf, ...(f.trigger_event_id ? { trigger_event_id: f.trigger_event_id } : {}) } });
    const id = `sup-deceased-${f.loan_id}-${f.party_id}`; const now = this.now();
    this.store.put(SUPPRESSIONS, id, { loan_id: f.loan_id, party_id: f.party_id, reason: "deceased", mechanism: "flag_only", codes: ["ECOA X"], starts_on: f.confirmed_on, ends_on: null, status: "active", trigger_event_id: ev.id, evidence_document_id: f.evidence_document_id, evidence_kind: f.evidence_kind, created_by: `${this.actor.kind}:${this.actor.id}`, created_at: now }, this.actor, now);
    this.events.append({ type: "credit.suppression.created", loanId: f.loan_id, actor: this.actor, payload: { id, reason: "deceased", mechanism: "flag_only", party_id: f.party_id, codes: ["ECOA X"], starts_on: f.confirmed_on, ends_on: null, created_at: now, trigger_event_id: ev.id, evidence_document_id: f.evidence_document_id } });
    return { event_id: ev.id, suppression_id: id, ecoa_x_from_cycle_as_of: cycleAsOf, next_cycle_snapshot_on: nextSnapshotOn };
  }
  /** Rule 6 / edge "deceased marker on the wrong consumer": release with proof of life, urgent AUD within 2 BD, `officer` notified. */
  deceasedInError(f: { suppression_id: string; proof_of_life_document_id: string }): { released: true; urgent: "deceased_in_error" } {
    const row = this.store.get(SUPPRESSIONS, f.suppression_id); if (!row) throw new RangeError(`no suppression ${f.suppression_id}`);
    if (row.data.reason !== "deceased") throw new RangeError(`${f.suppression_id} is not a deceased marker`);
    need(f.proof_of_life_document_id, "proof_of_life_document_id");
    const now = this.now(); const loanId = String(row.data.loan_id);
    this.store.put(SUPPRESSIONS, row.id, { status: "released", released_reason: "deceased_in_error", release_evidence_document_id: f.proof_of_life_document_id, ends_on: now.slice(0, 10) }, this.actor, now);
    this.events.append({ type: "credit.suppression.released", loanId, actor: this.actor, payload: { id: row.id, reason: "deceased", released_by: this.actor.id, released_reason: "deceased_in_error", evidence_document_id: f.proof_of_life_document_id } });
    this.events.append({ type: "credit.overlay.urgent", loanId, actor: this.actor, payload: { kind: "deceased_in_error", suppression_id: row.id, party_id: row.data.party_id ?? null, event: now } });
    this.escalations?.open({ kind: "officer", loanId, payload: { task: "deceased_marker_in_error", suppression_id: row.id, party_id: row.data.party_id ?? null, proof_of_life_document_id: f.proof_of_life_document_id } }, this.actor);
    return { released: true, urgent: "deceased_in_error" };
  }

  // ---- rule 7: identity theft (e-OSCAR Block notification at the designated address) ----
  ingestBlockNotice(f: { loan_id: string; party_id: string; control_number: string; cra: Bureau; received_at: string; identity_theft_report_id?: string; never_liable?: boolean }): IdentityTheftResponse & { block_event_id: string; suppression_id: string; fraud_case_opened: true } {
    need(f.loan_id, "loan_id"); need(f.party_id, "party_id"); need(f.control_number, "control_number"); need(f.received_at, "received_at");
    if (!BUREAUS.has(f.cra)) throw new RangeError(`cra must be one of ${[...BUREAUS].join(", ")}`);
    if (Number.isNaN(Date.parse(f.received_at))) throw new RangeError("received_at must be an ISO instant or date");
    const neverLiable = f.never_liable === true;
    if (neverLiable) requireOfficer(this.actor, "delete_consumer (ECOA Z) for a consumer who was never liable");   // 8.3 guardrail: delete_consumer requires `officer`
    const receivedOn = etDate(f.received_at); const now = this.now();
    const block = this.events.append({ type: "credit.block.notice.received", loanId: f.loan_id, actor: this.actor, payload: { kind: "Block", control_number: f.control_number, cra: f.cra, party_id: f.party_id, received_at: f.received_at, received_on: receivedOn, identity_theft_report_id: f.identity_theft_report_id ?? null, action: "omit_account_immediately_and_open_fraud_case" } });
    const it = identityTheftResponse({ party_id: f.party_id, received_on: receivedOn, never_liable: neverLiable });
    const id = `sup-idtheft-${f.loan_id}-${f.party_id}-${f.control_number}`;
    const evidence = f.identity_theft_report_id ?? `eoscar-block-${f.control_number}`;
    this.store.put(SUPPRESSIONS, id, { ...it.suppression, codes: [...(it.suppression.codes ?? [])], loan_id: f.loan_id, reason: "identity_theft_block", status: "active", trigger_event_id: block.id, evidence_document_id: evidence, control_number: f.control_number, cra: f.cra, aud_due: it.aud_due, created_by: `${this.actor.kind}:${this.actor.id}`, created_at: now }, this.actor, now);
    this.events.append({ type: "credit.suppression.created", loanId: f.loan_id, actor: this.actor, payload: { id, reason: "identity_theft_block", mechanism: it.suppression.mechanism, party_id: f.party_id, codes: [...(it.suppression.codes ?? [])], starts_on: receivedOn, ends_on: null, created_at: now, trigger_event_id: block.id, evidence_document_id: evidence } });
    this.events.append({ type: "credit.overlay.urgent", loanId: f.loan_id, actor: this.actor, payload: { kind: it.urgent_event.kind, suppression_id: id, party_id: f.party_id, event: f.received_at, aud_due: it.aud_due, aud_action: neverLiable ? "ecoa_z_delete_consumer" : "remove_consumer_segment" } });
    this.events.append({ type: "case.fraud.opened", loanId: f.loan_id, actor: this.actor, payload: { loan_id: f.loan_id, party_id: f.party_id, source: "8.3 e-OSCAR Block notification (§1681c-2)", control_number: f.control_number, cra: f.cra, opened_at: now, suppression: { reason: "identity_theft_block", mechanism: it.suppression.mechanism, codes: [...(it.suppression.codes ?? [])] }, resumption_requires: [...it.resumption_requires] } });
    this.escalations?.open({ kind: "officer", loanId: f.loan_id, payload: { task: "fraud_case_review", party_id: f.party_id, control_number: f.control_number, fannie_mae_fraud_reporting: "through officer (19.x)", resumption_requires: [...it.resumption_requires] } }, this.actor);
    return { ...it, block_event_id: block.id, suppression_id: id, fraud_case_opened: true };
  }

  // ---- SM_CR_SUPPRESSION_REVIEW_30: the 30-day review while active ------------
  reviewSuppression(f: { suppression_id: string; reviewed_on: PlainDate; docket?: { status: "open" | "dismissed" | "discharged"; event_on: PlainDate | null; order_document_id: string | null } }): { review_due_on: PlainDate; next_review_on: PlainDate; stale: boolean; action: ReturnType<typeof staleSuppressionReview>["action"]; escalation: "officer" | "human_agent" | null } {
    const row = this.store.get(SUPPRESSIONS, f.suppression_id); if (!row) throw new RangeError(`no suppression ${f.suppression_id}`);
    if (!isDate(f.reviewed_on)) throw new RangeError("reviewed_on is required (PlainDate)");
    const d = row.data; const loanId = String(d.loan_id);
    const lastEventOn = isDate(d.last_event_on) ? d.last_event_on : isDate(d.reviewed_on) ? d.reviewed_on : (String(d.starts_on) as PlainDate);
    let stale = false; let action: ReturnType<typeof staleSuppressionReview>["action"] = null; let escalation: "officer" | "human_agent" | null = null;
    let due = staleSuppressionReviewDue(lastEventOn);
    if (String(d.reason).startsWith("bankruptcy") && f.docket) {
      const r = staleSuppressionReview({ suppression: { reason: "bankruptcy", chapter: (Number(d.chapter ?? 13) as BankruptcyState["chapter"]), phase: (String(d.phase ?? "petition") as "petition" | "plan_confirmed" | "discharged" | "dismissed"), last_event_on: lastEventOn }, docket: f.docket, review_on: f.reviewed_on });
      due = r.review_due_on; stale = r.mismatch; action = r.action; escalation = r.escalation;
    }
    // an expired-but-still-active bar or a freeze the monitor never released is an accuracy failure (row breach: escalate `human_agent`)
    if (d.status === "active" && isDate(d.ends_on) && d.ends_on < f.reviewed_on) stale = true;
    if (stale && !escalation) escalation = "human_agent";
    const next = addDays(f.reviewed_on, SUPPRESSION_REVIEW_DAYS); const now = this.now();
    this.store.put(SUPPRESSIONS, row.id, { reviewed_on: f.reviewed_on, next_review_on: next, stale, ...(action ? { phase: "dismissed", codes: [`CII ${action.cii_this_cycle}`], next_cycle_codes: [`CII ${action.cii_next_cycle}`], mechanism: "flag_only", freeze_released_on: f.reviewed_on, evidence_document_id: action.evidence_document_id } : {}) }, this.actor, now);
    this.events.append({ type: "credit.suppression.reviewed", loanId, actor: this.actor, payload: { id: row.id, reason: String(d.reason), mechanism: action ? "flag_only" : String(d.mechanism), party_id: d.party_id ?? null, reviewed_on: f.reviewed_on, reviewed_at: now, next_review_on: next, review_due_on: due, docket_checked: !!f.docket, consistent: !stale, stale, action: action ? { cii_this_cycle: action.cii_this_cycle, cii_next_cycle: action.cii_next_cycle, evidence_document_id: action.evidence_document_id, via: action.via } : null } });
    if (escalation) this.escalations?.open({ kind: escalation, loanId, payload: { task: "stale_suppression", suppression_id: row.id, reason: String(d.reason), review_due_on: due, docket: f.docket ?? null, action } }, this.actor);
    return { review_due_on: due, next_review_on: next, stale, action, escalation };
  }

  // ---- guardrail: no courtesy suppression (8.3-T12) ---------------------------
  logCourtesyRequest(f: { loan_id: string; party_id?: string | null; channel: string; utterance?: string; requested_on?: PlainDate }): { created: false; log_id: string; response: typeof COURTESY_RESPONSE; borrower_told: string; suppressions_for_loan: number } {
    need(f.loan_id, "loan_id"); need(f.channel, "channel");
    const base = courtesyRequest(); const now = this.now(); const id = `courtesy-${f.loan_id}-${now}`;
    this.store.put(COURTESY_REQUESTS, id, { loan_id: f.loan_id, party_id: f.party_id ?? null, channel: f.channel, utterance: f.utterance ?? null, requested_on: f.requested_on ?? etDate(now), suppression_created: false, response: COURTESY_RESPONSE, script: COURTESY_SCRIPT, log: base.log }, this.actor, now);
    this.events.append({ type: "credit.courtesy_request.logged", loanId: f.loan_id, actor: this.actor, payload: { id, party_id: f.party_id ?? null, channel: f.channel, suppression_created: false, response: COURTESY_RESPONSE, basis: "accuracy governs; a borrower's request is not a legal basis (8.3 guardrail)" } });
    return { created: false, log_id: id, response: COURTESY_RESPONSE, borrower_told: COURTESY_SCRIPT, suppressions_for_loan: this.store.list(SUPPRESSIONS, (d) => d.loan_id === f.loan_id).length };
  }
}

/** The first snapshot that carries a next-cycle overlay (deceased ECOA X, a bankruptcy phase's CII): the 1st of the month after the event (FNMA_C41_01_METRO2_SNAPSHOT_EOM, 00:05 ET). */
export function nextCycleSnapshotOn(eventOn: PlainDate): PlainDate { return startOfMonth(addMonths(eventOn, 1)); }
