/**
 * Fannie Mae rails. Each port is the contract the domain (5.x, 12.8, 15.x)
 * programs against; the Fake* implementations reproduce the counterparty's
 * documented behaviour — per-record LSDU feedback (hard / soft / invalid /
 * missing), Servicing Platform event responses (Accepted / Accepted with
 * Warnings / Rejected with a fatal rule), SMDU case lifecycle, P360 claims,
 * CRS's portal-only upload, Connect report pulls — plus scripted outages.
 */
import { createHash } from "node:crypto";
import { AdapterUnavailable, PermanentRejection, TransientFailure } from "./failures.ts";
import type { OutboundAdapter, OutboxMessage } from "./outbox.ts";

/** Shared outage/latency script for every fake. */
export class FakeControls {
  outage = false;
  transientFailuresRemaining = 0;
  /** Simulate an outage: every call throws AdapterUnavailable until cleared. */
  setOutage(on: boolean): void { this.outage = on; }
  /** Fail the next n calls with a TransientFailure (5xx / timeout), then succeed. */
  failNext(n: number): void { this.transientFailuresRemaining = n; }
  check(adapter: string, fallbackKind: string): void {
    if (this.outage) throw new AdapterUnavailable(adapter, fallbackKind);
    if (this.transientFailuresRemaining > 0) { this.transientFailuresRemaining--; throw new TransientFailure(`${adapter}: 503 Service Unavailable`); }
  }
}

// ---------------------------------------------------------------- LSDU (LAR channel)
export type LarFeedbackKind = "accepted" | "hard" | "soft" | "invalid" | "missing";
export interface LarRecord { readonly fnmaLoanNumber: string; readonly record: string; readonly eventId: string; readonly sequence: number; }
export interface LarFeedback { readonly eventId: string; readonly fnmaLoanNumber: string; readonly kind: LarFeedbackKind; readonly code?: string; readonly message?: string; readonly fnmaExpected?: Record<string, string>; }
export interface LarSubmission { readonly submissionId: string; readonly acceptedAt: string; readonly records: number; }

export interface FnmaLsduPort {
  /** B2B transfer of an 80-char LAR file; feedback arrives 15–30 minutes later via `feedback`. */
  submitLarFile(records: readonly LarRecord[], now: string): Promise<LarSubmission>;
  feedback(submissionId: string): Promise<LarFeedback[]>;
  /** LSDU trial balance for the BD2 checklist (iv). */
  trialBalance(fnmaLoanNumbers: readonly string[]): Promise<Record<string, { lpi: string | null; upb_cents: string; ptr_pct: string; remittance_type: string }>>;
}

export interface LsduScript {
  /** Per-loan scripted response (default: accepted). */
  readonly rejects?: Record<string, { kind: Exclude<LarFeedbackKind, "accepted">; code: string; message: string; fnmaExpected?: Record<string, string> }>;
  readonly inactiveLoans?: readonly string[];
  readonly positions?: Record<string, { lpi: string | null; upb_cents: string; ptr_pct: string; remittance_type: string }>;
}

export class FakeFnmaLsdu implements FnmaLsduPort {
  readonly controls = new FakeControls();
  readonly submissions = new Map<string, { records: readonly LarRecord[]; feedback: LarFeedback[] }>();
  private script: LsduScript;
  constructor(script: LsduScript = {}) { this.script = script; }
  setScript(s: LsduScript): void { this.script = s; }
  async submitLarFile(records: readonly LarRecord[], now: string): Promise<LarSubmission> {
    this.controls.check("fnma-lsdu", "lsdu_file_upload");
    for (const r of records) if (r.record.length !== 80) throw new PermanentRejection("LAR_FORMAT", `record for ${r.fnmaLoanNumber} is ${r.record.length} chars, not 80`);
    const submissionId = createHash("sha256").update(records.map((r) => r.record).join("\n")).digest("hex").slice(0, 16);
    if (this.submissions.has(submissionId)) return { submissionId, acceptedAt: now, records: records.length };   // same file twice → same submission (idempotent transport)
    const feedback: LarFeedback[] = records.map((r) => {
      if (this.script.inactiveLoans?.includes(r.fnmaLoanNumber)) return { eventId: r.eventId, fnmaLoanNumber: r.fnmaLoanNumber, kind: "invalid", code: "INACTIVE_LOAN", message: "payment on inactive loan → readd_requests@fanniemae.com" };
      const s = this.script.rejects?.[r.fnmaLoanNumber];
      return s ? { eventId: r.eventId, fnmaLoanNumber: r.fnmaLoanNumber, kind: s.kind, code: s.code, message: s.message, ...(s.fnmaExpected ? { fnmaExpected: s.fnmaExpected } : {}) } : { eventId: r.eventId, fnmaLoanNumber: r.fnmaLoanNumber, kind: "accepted" };
    });
    this.submissions.set(submissionId, { records, feedback });
    return { submissionId, acceptedAt: now, records: records.length };
  }
  async feedback(submissionId: string): Promise<LarFeedback[]> { this.controls.check("fnma-lsdu", "lsdu_file_upload"); return this.submissions.get(submissionId)?.feedback ?? []; }
  async trialBalance(nums: readonly string[]): Promise<Record<string, { lpi: string | null; upb_cents: string; ptr_pct: string; remittance_type: string }>> {
    this.controls.check("fnma-lsdu", "lsdu_file_upload");
    const out: Record<string, { lpi: string | null; upb_cents: string; ptr_pct: string; remittance_type: string }> = {};
    for (const n of nums) { const p = this.script.positions?.[n]; if (p) out[n] = p; }
    return out;
  }
}

/** Head-of-line rule (5.1): a loan with an open hard/invalid reject blocks later-sequence events for that loan. */
export function headOfLineBlocked(openRejects: readonly { fnmaLoanNumber: string; kind: LarFeedbackKind; sequence: number }[], candidate: { fnmaLoanNumber: string; sequence: number }): boolean {
  return openRejects.some((r) => r.fnmaLoanNumber === candidate.fnmaLoanNumber && (r.kind === "hard" || r.kind === "invalid") && r.sequence < candidate.sequence);
}

/** Outbox adapter wrapping the LSDU port for the dispatcher. */
export class LsduOutboundAdapter implements OutboundAdapter<readonly LarRecord[], LarSubmission> {
  readonly name = "fnma-lsdu"; readonly fallbackKind = "lsdu_file_upload"; readonly fallbackRole = "fnma_portal_operator";
  private readonly port: FnmaLsduPort;
  constructor(port: FnmaLsduPort) { this.port = port; }
  send(payload: readonly LarRecord[], m: OutboxMessage): Promise<LarSubmission> { return this.port.submitLarFile(payload, m.lastAttemptAt ?? m.createdAt); }
}

// ---------------------------------------------------------------- Servicing Platform events (JSON)
export type ServicingEventStatus = "accepted" | "accepted_with_warnings" | "rejected";
export interface ServicingEvent { readonly eventId: string; readonly fnmaLoanNumber: string; readonly eventType: string; readonly body: Record<string, unknown>; }
export interface ServicingEventResponse { readonly eventId: string; readonly status: ServicingEventStatus; readonly messages: readonly { severity: "fatal" | "warning" | "notification"; code: string; message: string }[]; }
export interface ServicingEventsSubmission { readonly submissionId: string; readonly responses: readonly ServicingEventResponse[]; }

export interface FnmaServicingEventsPort {
  submitEvents(events: readonly ServicingEvent[], now: string): Promise<ServicingEventsSubmission>;
}
export interface ServicingEventsScript { readonly fatal?: Record<string, { code: string; message: string }>; readonly warnings?: Record<string, { code: string; message: string }>; }

export class FakeFnmaServicingEvents implements FnmaServicingEventsPort {
  readonly controls = new FakeControls();
  readonly received: ServicingEvent[] = [];
  private script: ServicingEventsScript;
  constructor(script: ServicingEventsScript = {}) { this.script = script; }
  setScript(s: ServicingEventsScript): void { this.script = s; }
  async submitEvents(events: readonly ServicingEvent[], now: string): Promise<ServicingEventsSubmission> {
    this.controls.check("fnma-servicing-events", "servicing_platform_ui_csv");
    if (events.length > 12_000) throw new PermanentRejection("BATCH_LIMIT", "UI CSV limit: ≤12,000 events per file");
    const perLoan = new Map<string, number>();
    for (const e of events) perLoan.set(e.fnmaLoanNumber, (perLoan.get(e.fnmaLoanNumber) ?? 0) + 1);
    for (const [loan, n] of perLoan) if (n > 100) throw new PermanentRejection("PER_LOAN_LIMIT", `${loan}: ${n} events > 100 per loan`);
    this.received.push(...events);
    const responses = events.map((e): ServicingEventResponse => {
      const fatal = this.script.fatal?.[e.eventId] ?? this.script.fatal?.[e.fnmaLoanNumber];
      if (fatal) return { eventId: e.eventId, status: "rejected", messages: [{ severity: "fatal", ...fatal }] };
      const w = this.script.warnings?.[e.eventId] ?? this.script.warnings?.[e.fnmaLoanNumber];
      return w ? { eventId: e.eventId, status: "accepted_with_warnings", messages: [{ severity: "warning", ...w }] } : { eventId: e.eventId, status: "accepted", messages: [] };
    });
    return { submissionId: `SE-${createHash("sha256").update(now + events.map((e) => e.eventId).join()).digest("hex").slice(0, 12)}`, responses };
  }
}

// ---------------------------------------------------------------- SMDU
export type SmduCaseStatus = "open" | "decisioned" | "tpp_active" | "completed" | "closed" | "declined" | "reclassified";
export interface SmduCase { readonly caseId: string; readonly fnmaLoanNumber: string; readonly program: string; status: SmduCaseStatus; readonly submitted: Record<string, unknown>; decision?: Record<string, unknown>; tppPayments: { dueDate: string; receivedOn: string; amountCents: string }[]; }
export interface FnmaSmduPort {
  createCase(fnmaLoanNumber: string, program: string, data: Record<string, unknown>): Promise<SmduCase>;
  decision(caseId: string): Promise<Record<string, unknown>>;
  reportTppPayment(caseId: string, p: { dueDate: string; receivedOn: string; amountCents: string }): Promise<{ acked: true }>;
  reclassify(caseId: string): Promise<{ status: "reclassified" }>;
  close(caseId: string, officerSignatureDate: string): Promise<{ status: "closed" }>;
}
export class FakeFnmaSmdu implements FnmaSmduPort {
  readonly controls = new FakeControls();
  readonly cases = new Map<string, SmduCase>();
  decisionFor: (c: SmduCase) => Record<string, unknown> = () => ({ outcome: "approved" });
  async createCase(fnmaLoanNumber: string, program: string, data: Record<string, unknown>): Promise<SmduCase> {
    this.controls.check("fnma-smdu", "smdu_ui_entry");
    const existing = [...this.cases.values()].find((c) => c.fnmaLoanNumber === fnmaLoanNumber && c.status !== "closed" && c.status !== "declined");
    if (existing) throw new PermanentRejection("CASE_OPEN", `loan ${fnmaLoanNumber} already has open SMDU case ${existing.caseId}`);
    const c: SmduCase = { caseId: `SMDU-${this.cases.size + 1}`, fnmaLoanNumber, program, status: "open", submitted: data, tppPayments: [] };
    this.cases.set(c.caseId, c); return c;
  }
  private case_(id: string): SmduCase { const c = this.cases.get(id); if (!c) throw new PermanentRejection("NO_CASE", `no SMDU case ${id}`); return c; }
  async decision(caseId: string): Promise<Record<string, unknown>> { this.controls.check("fnma-smdu", "smdu_ui_entry"); const c = this.case_(caseId); c.decision = this.decisionFor(c); c.status = c.decision["outcome"] === "declined" ? "declined" : "decisioned"; return c.decision; }
  async reportTppPayment(caseId: string, p: { dueDate: string; receivedOn: string; amountCents: string }): Promise<{ acked: true }> { this.controls.check("fnma-smdu", "smdu_ui_entry"); const c = this.case_(caseId); c.tppPayments.push(p); c.status = "tpp_active"; return { acked: true }; }
  async reclassify(caseId: string): Promise<{ status: "reclassified" }> { this.controls.check("fnma-smdu", "smdu_ui_entry"); this.case_(caseId).status = "reclassified"; return { status: "reclassified" }; }
  async close(caseId: string, officerSignatureDate: string): Promise<{ status: "closed" }> {
    this.controls.check("fnma-smdu", "smdu_ui_entry");
    const c = this.case_(caseId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(officerSignatureDate)) throw new PermanentRejection("OFFICER_SIGNATURE_DATE", "close requires the Officer Signature Date");
    c.status = "closed"; return { status: "closed" };
  }
}

// ---------------------------------------------------------------- Property 360
export type P360ClaimStatus = "submitted" | "in_review" | "psa" | "approved" | "paid" | "denied";
export interface P360Claim { readonly claimNumber: string; readonly fnmaLoanNumber: string; status: P360ClaimStatus; readonly lines: readonly Record<string, unknown>[]; readonly documents: string[]; history: { status: P360ClaimStatus; at: string }[]; }
export interface FnmaP360Port {
  confirmReogram(fnmaLoanNumber: string, data: Record<string, unknown>, now: string): Promise<{ reogramId: string; exceptions: string[] }>;
  submitClaim(claimNumber: string, fnmaLoanNumber: string, lines: readonly Record<string, unknown>[], now: string): Promise<P360Claim>;
  uploadDocument(claimNumber: string, documentId: string): Promise<{ acked: true }>;
  claimStatus(claimNumber: string): Promise<P360Claim>;
}
export class FakeFnmaP360 implements FnmaP360Port {
  readonly controls = new FakeControls();
  readonly claims = new Map<string, P360Claim>();
  readonly reograms = new Map<string, Record<string, unknown>>();
  reogramExceptions: (data: Record<string, unknown>) => string[] = () => [];
  async confirmReogram(fnmaLoanNumber: string, data: Record<string, unknown>, _now: string): Promise<{ reogramId: string; exceptions: string[] }> {
    this.controls.check("fnma-p360", "p360_reogram");
    this.reograms.set(fnmaLoanNumber, data);
    return { reogramId: `REO-${fnmaLoanNumber}`, exceptions: this.reogramExceptions(data) };
  }
  async submitClaim(claimNumber: string, fnmaLoanNumber: string, lines: readonly Record<string, unknown>[], now: string): Promise<P360Claim> {
    this.controls.check("fnma-p360", "p360_bulk_claim");
    const existing = this.claims.get(claimNumber);
    if (existing) return existing;   // idempotency by claim_number
    const c: P360Claim = { claimNumber, fnmaLoanNumber, status: "submitted", lines, documents: [], history: [{ status: "submitted", at: now }] };
    this.claims.set(claimNumber, c); return c;
  }
  async uploadDocument(claimNumber: string, documentId: string): Promise<{ acked: true }> { this.controls.check("fnma-p360", "p360_bulk_claim"); const c = this.claims.get(claimNumber); if (!c) throw new PermanentRejection("NO_CLAIM", claimNumber); if (!c.documents.includes(documentId)) c.documents.push(documentId); return { acked: true }; }
  async claimStatus(claimNumber: string): Promise<P360Claim> { this.controls.check("fnma-p360", "p360_bulk_claim"); const c = this.claims.get(claimNumber); if (!c) throw new PermanentRejection("NO_CLAIM", claimNumber); return c; }
  /** Test hook: move a claim through P360's states. */
  advance(claimNumber: string, status: P360ClaimStatus, at: string): void { const c = this.claims.get(claimNumber); if (!c) throw new RangeError(claimNumber); c.status = status; c.history.push({ status, at }); }
}

// ---------------------------------------------------------------- CRS (portal-only)
export interface CrsLine { readonly servicerNumber: string; readonly remittanceCode: string; readonly fnmaLoanNumber: string; readonly amountCents: bigint; readonly settlementDate: string; }
/** CRS batch file: positions 1–9 servicer, 10–13 code, 14–28 loan (15), 29–38 amount (10, cents), 39–48 settlement date (YYYYMMDD + 2 filler); ≤1,000 lines, ≤100 KB, split by servicer number and settlement date. */
export function buildCrsFiles(lines: readonly CrsLine[]): { name: string; content: string; lines: number }[] {
  const groups = new Map<string, CrsLine[]>();
  for (const l of lines) { const k = `${l.servicerNumber}|${l.settlementDate}`; let g = groups.get(k); if (!g) { g = []; groups.set(k, g); } g.push(l); }
  const out: { name: string; content: string; lines: number }[] = [];
  for (const [k, g] of groups) {
    for (let i = 0; i < g.length; i += 1000) {
      const chunk = g.slice(i, i + 1000);
      const content = chunk.map((l) => `${l.servicerNumber.padStart(9, "0")}${l.remittanceCode.padStart(4, "0")}${l.fnmaLoanNumber.padEnd(15, " ")}${l.amountCents.toString().padStart(10, "0")}${l.settlementDate.replace(/-/g, "")}  `).join("\n") + "\n";
      if (Buffer.byteLength(content) > 100 * 1024) throw new PermanentRejection("CRS_FILE_SIZE", "CRS file exceeds 100 KB");
      out.push({ name: `CRS_${k.replace("|", "_")}_${Math.floor(i / 1000) + 1}.txt`, content, lines: chunk.length });
    }
  }
  return out;
}

// ---------------------------------------------------------------- Fannie Mae Connect reports
export type ConnectReport = "loan_activity_summary" | "draft_request_report" | "sda_status" | "eligible_for_deselection" | "remittance_detail_pi" | "cash_adjustments" | "gfee_bill" | "amn_exceptions" | "amn_final";
export interface FnmaConnectPort { pull(report: ConnectReport, asOf: string): Promise<{ report: ConnectReport; asOf: string; rows: readonly Record<string, string>[] }>; }
export class FakeFnmaConnect implements FnmaConnectPort {
  readonly controls = new FakeControls();
  readonly reports = new Map<string, Record<string, string>[]>();
  seed(report: ConnectReport, asOf: string, rows: Record<string, string>[]): void { this.reports.set(`${report}@${asOf}`, rows); }
  async pull(report: ConnectReport, asOf: string): Promise<{ report: ConnectReport; asOf: string; rows: readonly Record<string, string>[] }> {
    this.controls.check("fnma-connect", "connect_pull");
    const rows = this.reports.get(`${report}@${asOf}`);
    if (!rows) throw new TransientFailure(`fnma-connect: ${report} for ${asOf} not yet refreshed`);
    return { report, asOf, rows };
  }
}
