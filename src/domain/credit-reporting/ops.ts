/**
 * §8 mechanics beyond metro2/disputes/suppression: the monthly cycle
 * (overlays → gates → validation → anomaly gate → four hashed files →
 * transmission → acknowledgments → corrections) with the events the 8.1 timer
 * rows arm on and are satisfied by, the officer-only release of a held cycle
 * and the DA/DF / ECOA Z / full-resubmission approvals (8.1 guardrails);
 * oral dispute intake, NoE-linked disputes and the AUD-vs-cycle rule (8.2);
 * the stale-suppression review against the docket (8.3). bigint cents; the
 * servicer calendar for the 5-BD resubmission and the 30-BD NoE clock.
 *
 * 8.1 names no bus tools in spec/registry/agents.json, so these run as domain
 * operations over an `EventStore`; the role gate is the same rule the bus
 * applies (a human actor with role `officer`).
 */
import { createHash } from "node:crypto";
import { addDays, type PlainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import type { Actor, EventStore } from "../../kernel/events/index.ts";
import { handleUtterance } from "../servicing-requests/ops.ts";
import { fdcpaGateIncludes, fdcpaGateOpensOn, staleSuppressionReviewDue, resolveSuppression, type FdcpaGateInput, type BankruptcyState, type Suppression, type Resolution } from "./suppression.ts";
import { directDisputeClocks, cccOnReceipt, BUREAUS, type Bureau } from "./disputes.ts";
import { renderBase, validateSnapshot, anomalyGate, transmissionClocks, correctDofd, carryPhp, type CycleRecordDelta, type AnomalyThresholds, DEFAULT_ANOMALY } from "./metro2.ts";
import type { Metro2Snapshot, Cii, Ccc, Ecoa, SpecialComment, AccountStatus } from "./types.ts";

// ---------------------------------------------------------------------------
// 8.1
// ---------------------------------------------------------------------------
/** A refusal by an 8.1 guardrail: nothing is written, the code names the rule. */
export class CreditReportingRefused extends Error {
  readonly code: string;
  constructor(code: string, why: string) { super(`${code}: ${why}`); this.name = "CreditReportingRefused"; this.code = code; }
}
export const isOfficer = (a: Actor | null | undefined): boolean => !!a && a.kind === "human" && a.role === "officer";
/** The 8.1 human touchpoint: `officer` releases held cycles and approves deletions/resubmissions. Refuses (writes nothing) otherwise. */
export function requireOfficer(actor: Actor | null | undefined, what: string): void {
  if (!isOfficer(actor)) throw new CreditReportingRefused("OFFICER_REQUIRED", `${what} requires officer approval; actor is ${actor ? `${actor.kind}:${actor.id}${actor.role ? ` (${actor.role})` : ""}` : "none"}`);
}

export interface AckReject { readonly line: number; readonly code: string; readonly message: string; readonly loan_id: string; readonly field?: string; }
export interface AckItem { readonly bureau: Bureau; readonly file_id: string; readonly line: number; readonly code: string; readonly loan_id: string; readonly classification: "data" | "configuration"; readonly status: "open" | "corrected" | "resolved"; readonly correction: { field: string; before: string | null; after: string | null; source: "loans" } | null; }
/** 8.1 rule 11–12 / T12: a bureau Metric Report's rejects become `metro2_ack_items`; data rejects are corrected from the loan record and resubmitted (or AUD'd) within 5 business days. */
export function ackRejectLoop(f: { bureau: Bureau; file_id: string; received_on: PlainDate; rejects: readonly AckReject[]; loans: Record<string, { min: string | null; fnma_loan_number: string }>; resubmitted_on?: PlainDate | null }): { items: AckItem[]; resubmit_by: PlainDate; via: "resubmission" | "aud"; resolved: boolean; unresolved: string[] } {
  const items: AckItem[] = f.rejects.map((r) => {
    const loan = f.loans[r.loan_id];
    if (/MIN/i.test(r.code) || r.field === "min") {
      const after = loan?.min ?? null;
      const ok = !!after && /^\d{18}$/.test(after);
      return { bureau: f.bureau, file_id: f.file_id, line: r.line, code: r.code, loan_id: r.loan_id, classification: "data", status: ok ? "corrected" : "open", correction: { field: "min", before: null, after: ok ? after : null, source: "loans" } };
    }
    if (/HEADER|TRAILER|PROGRAM|SUBSCRIBER/i.test(r.code)) return { bureau: f.bureau, file_id: f.file_id, line: r.line, code: r.code, loan_id: r.loan_id, classification: "configuration", status: "open", correction: null };
    return { bureau: f.bureau, file_id: f.file_id, line: r.line, code: r.code, loan_id: r.loan_id, classification: "data", status: "open", correction: null };
  });
  const by = addBusinessDays(f.received_on, 5, servicer);
  const resubmitted = !!f.resubmitted_on && f.resubmitted_on <= by;
  const final = items.map((i) => (i.status === "corrected" && resubmitted ? { ...i, status: "resolved" as const } : i));
  return { items: final, resubmit_by: by, via: items.every((i) => i.classification === "data") ? "aud" : "resubmission", resolved: final.every((i) => i.status === "resolved"), unresolved: final.filter((i) => i.status !== "resolved").map((i) => `${i.loan_id}:${i.code}`) };
}
/** 8.3 rule 8 / 8.1-T17: a loan boarded in default is omitted from the cycle until the FDCPA gate opens; omitted months render `D` in the PHP thereafter. */
export function fdcpaCycleInclusion(f: { boarded_in_default: boolean; gate: FdcpaGateInput; cycle_as_of: PlainDate }): { include: boolean; omit_reason: "fdcpa_pre_furnishing_gate" | null; gate_opens_on: PlainDate | null; php_char_for_omitted_month: "D" } {
  if (!f.boarded_in_default) return { include: true, omit_reason: null, gate_opens_on: null, php_char_for_omitted_month: "D" };
  const inc = fdcpaGateIncludes(f.gate, f.cycle_as_of);
  return { include: inc, omit_reason: inc ? null : "fdcpa_pre_furnishing_gate", gate_opens_on: fdcpaGateOpensOn(f.gate), php_char_for_omitted_month: "D" };
}
export interface BureauConfig { readonly program_identifier: string; readonly subscriber_code: string; readonly file_naming: string; }
export interface Metro2File { readonly bureau: Bureau; readonly file_name: string; readonly header: { program_identifier: string; identification_number: string; record_count: number }; readonly records: readonly Record<string, string>[]; readonly trailer: { total_base_records: number }; readonly encrypted_to: string; /** SHA-256 of the rendered file (rule 11 idempotency key with cycle_id + bureau; 8.1-T1 "hashes recorded"). */ readonly hash: string; }
/** SHA-256 over the rendered records — the `metro2_files.hash` half of the idempotency key (rule 11). */
export function fileHash(cycleId: string, bureau: Bureau, records: readonly Record<string, string>[]): string {
  return createHash("sha256").update(`${cycleId}|${bureau}|${JSON.stringify(records)}`).digest("hex");
}
/** 8.1 rule 10 / T18: one canonical snapshot set renders exactly four files — one per bureau, Innovis included — with identical base segments, per-bureau headers and a recorded hash. Callers pass the *validated, overlaid* set (`buildCycle`). */
export function cycleFiles(f: { cycle_id: string; snapshots: readonly Metro2Snapshot[]; config: Record<Bureau, BureauConfig> }): Metro2File[] {
  const records = f.snapshots.map((s) => renderBase(s));
  return BUREAUS.map((b) => {
    const c = f.config[b]; if (!c) throw new RangeError(`no furnisher_config for ${b}`);
    return { bureau: b, file_name: c.file_naming.replace("{cycle}", f.cycle_id).replace("{bureau}", b), header: { program_identifier: c.program_identifier, identification_number: c.subscriber_code, record_count: records.length }, records, trailer: { total_base_records: records.length }, encrypted_to: `pgp:${b}`, hash: fileHash(f.cycle_id, b, records) };
  });
}

// ---- 8.3 overlay codes on a snapshot -------------------------------------------
const CCC_CODES: ReadonlySet<string> = new Set(["XB", "XC", "XH", "XR"]);
const SPECIAL_PRIORITY: readonly SpecialComment[] = ["CP", "AW", "AC", "CO", "AZ"];   // 8.3 state machine: CP > AW > AC > CO/CN > AZ
/** Apply a resolved suppression's codes (`CII D`, `XB`, `ECOA X`, `AW`, …) to the consumer segments — the "must apply 8.3 overlays before rendering" guardrail. `partyId` scopes consumer codes; null = every segment. */
export function applyOverlayCodes(s: Metro2Snapshot, r: Resolution | null, partyId: string | null = null): Metro2Snapshot {
  if (!r || r.codes.length === 0) return s;
  let special = s.special_comment;
  let consumers = s.consumers;
  const forParty = (fn: (c: Metro2Snapshot["consumers"][number]) => Metro2Snapshot["consumers"][number]) => { consumers = consumers.map((c) => (partyId === null || c.party_id === partyId ? fn(c) : c)); };
  for (const code of r.codes) {
    let m: RegExpExecArray | null;
    if ((m = /^CII ([A-Z])$/.exec(code))) { const cii = m[1] as Cii; forParty((c) => ({ ...c, cii })); }
    else if (CCC_CODES.has(code)) { const ccc = code as Ccc; forParty((c) => ({ ...c, ccc })); }
    else if ((m = /^ECOA ([XZT])$/.exec(code))) { const ecoa = m[1] as Ecoa; forParty((c) => ({ ...c, ecoa })); }
    else if (SPECIAL_PRIORITY.includes(code as SpecialComment)) {
      const cand = code as SpecialComment;
      if (special === "" || SPECIAL_PRIORITY.indexOf(cand) < SPECIAL_PRIORITY.indexOf(special)) special = cand;
    }
  }
  consumers = consumers.map((c) => ({ ...c, special_comment: c.special_comment === "H" ? "H" : special }));
  return { ...s, special_comment: special, consumers, derivation: [...s.derivation, `overlay ${r.mechanism} [${r.reasons.join(",")}] codes ${r.codes.join(" ")}`] };
}

// ---- the monthly cycle (state machine: building → validated → (held)? → transmitted → acknowledged → closed) ----
export interface CycleRecordInput {
  readonly snapshot: Metro2Snapshot;
  /** The 8.3 overlay hook: mechanisms (as_if_paid_projection / freeze_status / ECOA X / AW) applied to the snapshot at `evaluated_on` before codes merge and validation (ops-8-3.ts overlayHook; 8.3 rule 1 "applied at transmission time"). */
  readonly overlay?: (snapshot: Metro2Snapshot, evaluated_on: PlainDate) => Metro2Snapshot;
  /** Active 8.3 suppressions for the loan (evaluated on `evaluated_on`, i.e. at transmission — 8.3 rule 1). */
  readonly suppressions?: readonly Suppression[];
  /** FDCPA pre-furnishing gate (8.1-T17 / 8.3 rule 8). */
  readonly fdcpa?: { readonly boarded_in_default: boolean; readonly gate: FdcpaGateInput };
  /** For the anomaly gate (rule 9, soft): last cycle's status/DOFD and whether a `loan_events` row explains a change. */
  readonly prior_status?: AccountStatus | null;
  readonly prior_dofd?: PlainDate | null;
  readonly explained_by_event?: boolean;
  /** B-1 evidence on file for the loan/consumer (hello notice 1.3 / first statement 7.1). */
  readonly b1_on_file?: boolean;
}
export interface CycleException { readonly loan_id: string; readonly errors: readonly string[]; readonly routed_to: "credit-reporting"; readonly sla: "same_day"; readonly resolution: "omitted_from_file"; readonly php_next_month: "D"; }
export interface OverlayDecision { readonly loan_id: string; readonly mechanism: Resolution["mechanism"] | "report"; readonly codes: readonly string[]; readonly reasons: readonly string[]; }
export interface CycleBuild {
  readonly cycle_id: string;
  readonly as_of: PlainDate;
  readonly status: "validated" | "held";
  readonly held_reasons: readonly string[];
  readonly approved_by: string | null;
  readonly files: readonly Metro2File[];
  readonly hashes: Readonly<Record<Bureau, string>>;
  /** The validated, overlaid snapshots the files carry (in file order). */
  readonly included: readonly Metro2Snapshot[];
  readonly omitted: readonly { loan_id: string; reason: string }[];
  readonly exceptions: readonly CycleException[];
  readonly overlay_decisions: readonly OverlayDecision[];
  readonly record_count: number;
  /** BD3 target / 10-calendar-day hard stop (SM_METRO2_TRANSMIT_ALL4_BD3 / _HARD_CD10). */
  readonly transmit_by: { target: PlainDate; hard_stop: PlainDate };
  readonly negative_information: ReadonlySet<string>;
  readonly b1_on_file: ReadonlySet<string>;
}
const NEGATIVE_STATUSES: ReadonlySet<AccountStatus> = new Set(["71", "78", "80", "82", "83", "84", "65", "89", "94", "97"]);
export const isNegativeInformation = (s: Metro2Snapshot): boolean => NEGATIVE_STATUSES.has(s.account_status);
/**
 * Build a cycle from per-loan snapshots: 8.3 overlays and the FDCPA gate first
 * (omit_account / delete_* → omitted with reason), then rule 9 hard validation
 * — a record with an error is routed to the `credit-reporting` agent and
 * omitted (PHP `D` next month), never furnished wrong — then the soft anomaly
 * gate holds the whole cycle for `officer` release, then four hashed files.
 */
export function buildCycle(f: { cycle_id: string; as_of: PlainDate; records: readonly CycleRecordInput[]; config: Record<Bureau, BureauConfig>; evaluated_on?: PlainDate; thresholds?: AnomalyThresholds }): CycleBuild {
  const on = f.evaluated_on ?? f.as_of;
  const included: Metro2Snapshot[] = []; const omitted: { loan_id: string; reason: string }[] = []; const exceptions: CycleException[] = []; const decisions: OverlayDecision[] = []; const deltas: CycleRecordDelta[] = [];
  const negative = new Set<string>(); const b1 = new Set<string>();
  const suppresses = (m: Resolution["mechanism"] | undefined): boolean => m === "omit_account" || m === "delete_account" || m === "delete_consumer";
  for (const r of f.records) {
    const id = r.snapshot.loan_id;
    const snapshot = r.overlay ? r.overlay(r.snapshot, on) : r.snapshot;   // 8.3 mechanisms at the evaluation (transmission) date
    const supp = r.suppressions ?? [];
    const res = resolveSuppression(supp, on);
    decisions.push({ loan_id: id, mechanism: res?.mechanism ?? "report", codes: res?.codes ?? [], reasons: res?.reasons ?? [] });
    const deleted = res?.mechanism === "delete_account" || res?.mechanism === "delete_consumer";
    if (r.b1_on_file) b1.add(id);
    // Per-consumer resolution (8.3: "omit_account for the affected consumer"): a suppressed base
    // consumer (or an account-wide suppression) omits the record; a suppressed J1/J2 drops its segment.
    const perConsumer = snapshot.consumers.map((c) => ({ c, res: resolveSuppression(supp, on, c.party_id) }));
    const suppressedConsumers = perConsumer.filter((x) => suppresses(x.res?.mechanism));
    const omitRecord = suppressedConsumers.length > 0 && (suppressedConsumers.length === perConsumer.length || suppressedConsumers.some((x) => x.c.segment === "base"));
    if (omitRecord) { omitted.push({ loan_id: id, reason: `${res!.mechanism}:${res!.reasons.join(",")}` }); deltas.push({ loan_id: id, prior_status: r.prior_status ?? null, status: snapshot.account_status, explained_by_event: r.explained_by_event ?? false, dofd_moved_later: false, deleted }); continue; }
    if (r.fdcpa && !fdcpaCycleInclusion({ boarded_in_default: r.fdcpa.boarded_in_default, gate: r.fdcpa.gate, cycle_as_of: f.as_of }).include) { omitted.push({ loan_id: id, reason: "fdcpa_pre_furnishing_gate" }); continue; }
    let overlaid: Metro2Snapshot = suppressedConsumers.length ? { ...snapshot, consumers: snapshot.consumers.filter((c) => !suppressedConsumers.some((x) => x.c.party_id === c.party_id)), derivation: [...snapshot.derivation, `segments omitted: ${suppressedConsumers.map((x) => `${x.c.party_id} (${x.res!.mechanism}:${x.res!.reasons.join(",")})`).join("; ")}`] } : snapshot;
    for (const { c, res: cr } of perConsumer) if (cr && !suppresses(cr.mechanism)) overlaid = applyOverlayCodes(overlaid, cr, c.party_id);
    const errors = validateSnapshot(overlaid);
    if (errors.length) { exceptions.push({ loan_id: id, errors, routed_to: "credit-reporting", sla: "same_day", resolution: "omitted_from_file", php_next_month: "D" }); omitted.push({ loan_id: id, reason: `hard_error:${errors.join(",")}` }); continue; }
    deltas.push({ loan_id: id, prior_status: r.prior_status ?? null, status: overlaid.account_status, explained_by_event: r.explained_by_event ?? false, dofd_moved_later: !!(r.prior_dofd && overlaid.dofd && overlaid.dofd > r.prior_dofd), deleted: false });
    if (isNegativeInformation(overlaid)) negative.add(id);
    included.push(overlaid);
  }
  const gate = anomalyGate(deltas, f.thresholds ?? DEFAULT_ANOMALY);
  const files = cycleFiles({ cycle_id: f.cycle_id, snapshots: included, config: f.config });
  const hashes = Object.fromEntries(files.map((x) => [x.bureau, x.hash])) as Record<Bureau, string>;
  return { cycle_id: f.cycle_id, as_of: f.as_of, status: gate.held ? "held" : "validated", held_reasons: gate.reasons, approved_by: null, files, hashes, included, omitted, exceptions, overlay_decisions: decisions, record_count: included.length, transmit_by: transmissionClocks(f.as_of), negative_information: negative, b1_on_file: b1 };
}
/** Next month's PHP for a loan this cycle omitted (rule 9 / 8.1-T9): the omitted month renders `D`. */
export function phpAfterOmission(s: Metro2Snapshot): string { return carryPhp({ php: s.php, status: null, dofd: s.dofd, omitted: true }); }

export interface CorrectionInput {
  readonly loan_id: string; readonly borrower_id?: string;
  readonly source: "ack_reject" | "dispute_acdv" | "dispute_direct" | "noe" | "qc" | "transfer" | "self_identified";
  readonly fields_changed: readonly { field: string; before: string | null; after: string | null }[];
  readonly evidence_document_id?: string | null;
  readonly determined_on: PlainDate;
  readonly adds_negative_information?: boolean;
  readonly b1_on_file?: boolean;
}
const DELETE_FIELD_VALUES: readonly { field: string; values: readonly string[] }[] = [{ field: "account_status", values: ["DA", "DF"] }, { field: "ecoa", values: ["Z"] }];
/** Fields the 8.1 guardrail lets change only through a corrections row *with evidence* (PHP history, Date Opened, DOFD). */
const EVIDENCE_FIELDS: ReadonlySet<string> = new Set(["payment_history_profile", "php", "date_opened", "date_of_first_delinquency", "dofd"]);
/**
 * The cycle runner: emits the 8.1 events over the loan event log so the registry
 * timers arm and satisfy (`credit.cycle.opened` → SM_METRO2_TRANSMIT_*, `metro2.file.transmitted`
 * → SM_METRO2_ACK_EXPECTED_BD, `metro2.ack.received` → SM_METRO2_REJECT_RESOLVE_BD5,
 * `credit.correction.created` → FCRA_1681S2A2_CORRECTION_PROMPT_BD2, `metro2.loan.furnished`
 * → FCRA_1681S2A7_NEG_INFO_NOTICE_30 / FCRA_1681S2A5_DOFD_90). Every guardrail refuses
 * before an event is written.
 */
export class CreditCycleRunner {
  private readonly events: EventStore;
  private readonly actor: Actor;
  constructor(events: EventStore, actor: Actor) { this.events = events; this.actor = actor; }
  private cycleAgg(cycleId: string): { kind: string; id: string } { return { kind: "metro2_cycle", id: cycleId }; }
  /** `credit.cycle.opened` creates the `metro2_cycles` row {cycle_id, as_of_date, status='building'} — the anchor the BD3/CD10 rows read. */
  open(cycleId: string, asOf: PlainDate): { cycle_id: string; as_of: PlainDate; status: "building" } {
    this.events.append({ type: "credit.cycle.opened", aggregate: this.cycleAgg(cycleId), actor: this.actor, payload: { cycle_id: cycleId, as_of_date: asOf, status: "building" } });
    return { cycle_id: cycleId, as_of: asOf, status: "building" };
  }
  /** Build, then record `credit.cycle.snapshot_completed` (FNMA_C41_01_METRO2_SNAPSHOT_EOM) and `credit.cycle.validated` (SM_APPX_E_SAMPLE_VERIFY_MONTHLY) or `credit.cycle.held`. */
  build(f: Parameters<typeof buildCycle>[0]): CycleBuild {
    const b = buildCycle(f);
    const agg = this.cycleAgg(b.cycle_id);
    this.events.append({ type: "credit.cycle.snapshot_completed", aggregate: agg, actor: this.actor, payload: { cycle_id: b.cycle_id, as_of_date: b.as_of, record_count: b.record_count, omitted: b.omitted.length, exceptions: b.exceptions.map((e) => ({ loan_id: e.loan_id, errors: [...e.errors] })) } });
    for (const e of b.exceptions) this.events.append({ type: "credit.cycle.exception", loanId: e.loan_id, actor: this.actor, payload: { cycle_id: b.cycle_id, errors: [...e.errors], routed_to: e.routed_to, sla: e.sla, resolution: e.resolution } });
    if (b.status === "held") this.events.append({ type: "credit.cycle.held", aggregate: agg, actor: this.actor, payload: { cycle_id: b.cycle_id, reasons: [...b.held_reasons], release_requires: "officer" } });
    else this.events.append({ type: "credit.cycle.validated", aggregate: agg, actor: this.actor, payload: { cycle_id: b.cycle_id, as_of_date: b.as_of, record_count: b.record_count, hashes: { ...b.hashes } } });
    return b;
  }
  /** 8.1-T10: "the cycle is `held` and only `officer` can release it" (guardrail: the agent may not release a cycle whose anomaly score exceeds thresholds). */
  release(b: CycleBuild, approver: Actor, rationale: string): CycleBuild {
    if (b.status !== "held") return b;
    requireOfficer(approver, `release of held cycle ${b.cycle_id} (${b.held_reasons.join("; ")})`);
    this.events.append({ type: "credit.cycle.released", aggregate: this.cycleAgg(b.cycle_id), actor: approver, payload: { cycle_id: b.cycle_id, reasons: [...b.held_reasons], rationale, approved_by: approver.id } });
    this.events.append({ type: "credit.cycle.validated", aggregate: this.cycleAgg(b.cycle_id), actor: approver, payload: { cycle_id: b.cycle_id, as_of_date: b.as_of, record_count: b.record_count, hashes: { ...b.hashes }, released_by: approver.id } });
    return { ...b, status: "validated", approved_by: approver.id };
  }
  /**
   * `validated → transmitted(per bureau)`: refuses a held cycle and any record with an
   * unresolved hard error (§1681s-2(a)(1)(A)); emits `metro2.file.transmitted` per bureau
   * (subject = the file) and once with `all_bureaus=true` (subject = the cycle), and per
   * loan `metro2.loan.furnished` (+ `credit.dofd.furnished{via=file}` when a 93/97 record carries its DOFD).
   */
  transmit(b: CycleBuild, transmittedAt: string, opts: { resubmission_of?: string | null; approver?: Actor } = {}): { transmitted: { bureau: Bureau; file_id: string; hash: string; file_name: string }[]; transmitted_on: PlainDate; on_time: boolean } {
    if (b.status === "held") throw new CreditReportingRefused("CYCLE_HELD", `cycle ${b.cycle_id} is held (${b.held_reasons.join("; ")}); an officer must release it`);
    const bad = b.included.filter((s) => validateSnapshot(s).length > 0);
    if (bad.length) throw new CreditReportingRefused("UNRESOLVED_HARD_ERROR", `records with unresolved hard errors may not be furnished: ${bad.map((s) => s.loan_id).join(", ")}`);
    if (opts.resubmission_of) requireOfficer(opts.approver, `full-file resubmission of ${opts.resubmission_of}`);
    const transmittedOn = transmittedAt.slice(0, 10) as PlainDate;
    const out: { bureau: Bureau; file_id: string; hash: string; file_name: string }[] = [];
    for (const file of b.files) {
      const fileId = `${b.cycle_id}:${file.bureau}:${file.hash.slice(0, 12)}`;
      out.push({ bureau: file.bureau, file_id: fileId, hash: file.hash, file_name: file.file_name });
      this.events.append({ type: "metro2.file.transmitted", aggregate: { kind: "metro2_file", id: fileId }, actor: this.actor, payload: { cycle_id: b.cycle_id, bureau: file.bureau, file_id: fileId, hash: file.hash, file_name: file.file_name, record_count: file.header.record_count, transmitted_at: transmittedAt, all_bureaus: false, resubmission_of: opts.resubmission_of ?? null } });
    }
    this.events.append({ type: "metro2.file.transmitted", aggregate: this.cycleAgg(b.cycle_id), actor: this.actor, payload: { cycle_id: b.cycle_id, all_bureaus: true, bureaus: out.map((o) => o.bureau), hashes: { ...b.hashes }, transmitted_at: transmittedAt } });
    for (const s of b.included) {
      const negative = b.negative_information.has(s.loan_id);
      this.events.append({ type: "metro2.loan.furnished", loanId: s.loan_id, actor: this.actor, payload: { cycle_id: b.cycle_id, account_status: s.account_status, dofd: s.dofd, negative_information: negative, b1_on_file: b.b1_on_file.has(s.loan_id), transmitted_at: transmittedAt } });
      if ((s.account_status === "97" || (s.account_status as string) === "93") && s.dofd) this.events.append({ type: "credit.dofd.furnished", loanId: s.loan_id, actor: this.actor, payload: { via: "file", dofd: s.dofd, cycle_id: b.cycle_id } });
    }
    return { transmitted: out, transmitted_on: transmittedOn, on_time: transmittedOn <= b.transmit_by.target };
  }
  /** Bureau acknowledgment: `metro2.ack.received{reject_count, received_at}` (SM_METRO2_ACK_EXPECTED_BD satisfied; SM_METRO2_REJECT_RESOLVE_BD5 armed when rejects > 0) and, when every item resolves, `metro2.ack.items.resolved{pending=0}`. */
  ingestAck(f: Parameters<typeof ackRejectLoop>[0]): ReturnType<typeof ackRejectLoop> {
    const r = ackRejectLoop(f);
    const agg = { kind: "metro2_file", id: f.file_id };
    this.events.append({ type: "metro2.ack.received", aggregate: agg, actor: this.actor, payload: { bureau: f.bureau, file_id: f.file_id, received_at: f.received_on, reject_count: f.rejects.length, items: r.items.map((i) => ({ loan_id: i.loan_id, code: i.code, classification: i.classification, status: i.status })) } });
    if (f.rejects.length > 0 && r.resolved) this.events.append({ type: "metro2.ack.items.resolved", aggregate: agg, actor: this.actor, payload: { bureau: f.bureau, file_id: f.file_id, pending: 0, via: r.via, resubmit_by: r.resubmit_by } });
    return r;
  }
  /** The 5-BD loop closes: a resubmission/AUD within `resubmit_by` resolves the items → `metro2.ack.items.resolved{pending=0}` (SM_METRO2_REJECT_RESOLVE_BD5 satisfied). */
  resolveAckItems(f: Parameters<typeof ackRejectLoop>[0] & { resubmitted_on: PlainDate }): ReturnType<typeof ackRejectLoop> {
    const r = ackRejectLoop(f);
    this.events.append({ type: "metro2.ack.items.resolved", aggregate: { kind: "metro2_file", id: f.file_id }, actor: this.actor, payload: { bureau: f.bureau, file_id: f.file_id, pending: r.unresolved.length, via: r.via, resubmit_by: r.resubmit_by, resubmitted_on: f.resubmitted_on, unresolved: [...r.unresolved] } });
    return r;
  }
  /**
   * Rule 12 / 8.1-T14: a `credit_reporting_corrections` row. DOFD may move later only with
   * evidence (DOFD_REAGE_BLOCKED); DA/DF and ECOA `Z` need `officer` approval; emits
   * `credit.correction.created{determined_on}` (FCRA_1681S2A2_CORRECTION_PROMPT_BD2).
   */
  createCorrection(c: CorrectionInput, approver?: Actor): { correction: CorrectionInput & { aud_due: PlainDate; b2_notice_due: PlainDate | null; requires_officer: boolean } } {
    for (const ch of c.fields_changed) {
      if (ch.field === "date_of_first_delinquency" || ch.field === "dofd") correctDofd(ch.before as PlainDate | null, ch.after as PlainDate | null, c.evidence_document_id ?? null);
    }
    // 8.1 guardrail: "may not alter `payment_history_profile` history, `date_opened` or `date_of_first_delinquency` except
    // through a `credit_reporting_corrections` row with evidence" — the row carries its evidence document or is refused.
    const guarded = c.fields_changed.filter((ch) => EVIDENCE_FIELDS.has(ch.field));
    if (guarded.length && !c.evidence_document_id) throw new CreditReportingRefused("CORRECTION_NEEDS_EVIDENCE", `${guarded.map((g) => g.field).join(", ")} may only change through a credit_reporting_corrections row with evidence_document_id`);
    const deletes = c.fields_changed.filter((ch) => DELETE_FIELD_VALUES.some((d) => d.field === ch.field && ch.after !== null && d.values.includes(ch.after)));
    if (deletes.length) requireOfficer(approver, `correction with ${deletes.map((d) => `${d.field}=${d.after}`).join(", ")} (DA/DF delete account / ECOA Z)`);
    const audDue = addBusinessDays(c.determined_on, 2, servicer);
    const b2 = c.adds_negative_information && !c.b1_on_file ? addDays(c.determined_on, 30) : null;
    this.events.append({ type: "credit.correction.created", loanId: c.loan_id, actor: this.actor, payload: { source: c.source, determined_on: c.determined_on, fields_changed: c.fields_changed.map((x) => ({ ...x })), evidence_document_id: c.evidence_document_id ?? null, aud_due: audDue, b2_notice_due: b2, ...(approver ? { approved_by: approver.id } : {}) } });
    return { correction: { ...c, aud_due: audDue, b2_notice_due: b2, requires_officer: deletes.length > 0 } };
  }
}

// ---------------------------------------------------------------------------
// 8.2
// ---------------------------------------------------------------------------
/** 8.2-T10: an oral statement on an AI voice call that the credit report is wrong opens a direct dispute; XB applies on receipt; results are due within 30 days; automation is disclosed. */
export function oralDisputeIntake(f: { utterance: string; received_on: PlainDate; next_cycle_transmit_on: PlainDate; automation_disclosed: boolean }): { opens_case: boolean; channel: "oral"; category: "payment_history" | "balance" | "not_mine" | "other"; ccc: "XB"; ccc_via: "aud" | "next_cycle"; results_due: PlainDate; results_template: "NTC_FCRA_1022_43E_RESULTS"; human_transfer_requested: boolean; automation_disclosed: boolean } {
  const u = f.utterance.toLowerCase();
  const disputes = /(credit report|credit bureau|my credit)/.test(u) && /(late|wrong|incorrect|not mine|never|inaccurate|error)/.test(u);
  const category = /late|payment|paid/.test(u) ? "payment_history" : /balance|owe/.test(u) ? "balance" : /not mine|never had/.test(u) ? "not_mine" : "other";
  const clocks = directDisputeClocks(f.received_on);
  return { opens_case: disputes, channel: "oral", category, ccc: "XB", ccc_via: cccOnReceipt(f.received_on, f.next_cycle_transmit_on).via, results_due: clocks.results_due, results_template: "NTC_FCRA_1022_43E_RESULTS", human_transfer_requested: handleUtterance(f.utterance).human_transfer_requested, automation_disclosed: f.automation_disclosed };
}
/** 8.2 rule 9 / T13: a letter alleging a servicing error and a wrong credit report opens both an NoE case (4.1, 30 business days) and a direct dispute (30 calendar days); corrections are shared and the letters meet their own clocks. */
export function linkedNoeDispute(f: { received_on: PlainDate; allegations: readonly string[] }): { noe_case: { opens: boolean; response_due: PlainDate; basis: string } | null; direct_dispute: { opens: boolean; results_due: PlainDate } | null; shared_corrections: boolean; combined_letter_allowed: boolean; earlier_clock: PlainDate | null } {
  const servicing = f.allegations.some((a) => /misapplied|late fee|late charge|escrow|payment/i.test(a));
  const credit = f.allegations.some((a) => /credit report|credit bureau|tradeline|furnish/i.test(a));
  const noeDue = addBusinessDays(f.received_on, 30, servicer);
  const dd = directDisputeClocks(f.received_on).results_due;
  const noe = servicing ? { opens: true, response_due: noeDue, basis: "§1024.35(e)(3)(i)(C): 30 business days (servicer calendar)" } : null;
  const direct = credit ? { opens: true, results_due: dd } : null;
  const earlier = noe && direct ? (noeDue < dd ? noeDue : dd) : null;
  return { noe_case: noe, direct_dispute: direct, shared_corrections: !!(noe && direct), combined_letter_allowed: !!(noe && direct), earlier_clock: earlier };
}
/** e-OSCAR AUD rule / 8.2-T14: an AUD never substitutes for in-cycle reporting — the next cycle carries the corrected values regardless of the AUD. */
export function audAndCycle(f: { aud_sent_on: PlainDate; cycle_as_of: PlainDate; corrected_fields: Record<string, string>; snapshot_fields: Record<string, string> }): { aud_in_cycle_substitute: false; cycle_carries_correction: boolean; mismatches: string[] } {
  const mismatches = Object.entries(f.corrected_fields).filter(([k, v]) => f.snapshot_fields[k] !== v).map(([k]) => k);
  return { aud_in_cycle_substitute: false, cycle_carries_correction: mismatches.length === 0, mismatches };
}

// ---------------------------------------------------------------------------
// 8.3
// ---------------------------------------------------------------------------
const DISMISSAL_CII: Readonly<Record<BankruptcyState["chapter"], Cii>> = { 7: "I", 11: "J", 12: "K", 13: "L" };
/** 8.3 edge "Bankruptcy monitor outage" / T11: the 30-day suppression review compares the live suppression with the docket; a dismissal the monitor missed is applied retroactively with the dismissal order as evidence (CII I/J/K/L for one cycle, then Q). */
export function staleSuppressionReview(f: { suppression: { reason: "bankruptcy"; chapter: BankruptcyState["chapter"]; phase: "petition" | "plan_confirmed" | "discharged" | "dismissed"; last_event_on: PlainDate }; docket: { status: "open" | "dismissed" | "discharged"; event_on: PlainDate | null; order_document_id: string | null }; review_on: PlainDate }): { review_due_on: PlainDate; mismatch: boolean; action: { cii_this_cycle: Cii; cii_next_cycle: "Q"; release_freeze: true; evidence_document_id: string; via: "aud_and_next_cycle" } | null; escalation: "officer" | null } {
  const due = staleSuppressionReviewDue(f.suppression.last_event_on);
  const mismatch = f.docket.status === "dismissed" && f.suppression.phase !== "dismissed";
  if (!mismatch) return { review_due_on: due, mismatch: false, action: null, escalation: null };
  if (!f.docket.order_document_id) return { review_due_on: due, mismatch: true, action: null, escalation: "officer" };
  return { review_due_on: due, mismatch: true, action: { cii_this_cycle: DISMISSAL_CII[f.suppression.chapter], cii_next_cycle: "Q", release_freeze: true, evidence_document_id: f.docket.order_document_id, via: "aud_and_next_cycle" }, escalation: null };
}
export const dayAfter = (d: PlainDate): PlainDate => addDays(d, 1);
