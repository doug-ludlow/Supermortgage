/**
 * Legal rails: PACER Case Locator (14.1 — SSN-only queries are rejected by
 * the API; a match needs SSN4 + last name), DMDC SCRA verification (13.8 —
 * portal/batch only, statuses X/Z are "unknown"), and e-recording (16.3 —
 * package create/submit/status with recorder rejects; idempotency by
 * (release_task_id, attempt)).
 */
import { AdapterUnavailable, PermanentRejection, TransientFailure } from "./failures.ts";

export interface PacerParty { readonly caseNumber: string; readonly court: string; readonly chapter: 7 | 11 | 12 | 13; readonly lastName: string; readonly firstName: string; readonly ssn4: string; readonly dateFiled: string; readonly status: "open" | "discharged" | "dismissed" | "closed"; }
export interface PacerQuery { readonly lastName?: string; readonly ssn4?: string; readonly ssn?: string; readonly dateFiledFrom: string; }
export interface PacerPort {
  auth(now: string): Promise<{ token: string; expiresAt: string }>;
  partiesFind(q: PacerQuery): Promise<{ reportId: string }>;
  reportStatus(reportId: string): Promise<"running" | "complete" | "failed">;
  reportDownload(reportId: string): Promise<readonly PacerParty[]>;
  deleteReport(reportId: string): Promise<void>;
  docket(caseNumber: string, since: string): Promise<readonly { seq: number; filedOn: string; kind: string; text: string }[]>;
}
export class FakePacer implements PacerPort {
  outage = false; transientRemaining = 0;
  readonly parties: PacerParty[] = [];
  readonly dockets = new Map<string, { seq: number; filedOn: string; kind: string; text: string }[]>();
  private readonly reports = new Map<string, PacerParty[]>();
  private check(): void { if (this.outage) throw new AdapterUnavailable("pacer/bk-monitor", "widen_date_filed_from_and_retry"); if (this.transientRemaining > 0) { this.transientRemaining--; throw new TransientFailure("pacer: 502"); } }
  async auth(now: string): Promise<{ token: string; expiresAt: string }> { this.check(); return { token: "CSO-TOKEN", expiresAt: new Date(Date.parse(now) + 8 * 3_600_000).toISOString() }; }
  async partiesFind(q: PacerQuery): Promise<{ reportId: string }> {
    this.check();
    if (!q.lastName) throw new PermanentRejection("SSN_ONLY", "PCL rejects SSN-only queries: lastName is required");
    if (q.ssn && !/^\d{9}$/.test(q.ssn)) throw new PermanentRejection("SSN_FORMAT", "full SSN must be 9 digits");
    const hits = this.parties.filter((p) => p.lastName.toLowerCase() === q.lastName!.toLowerCase() && p.dateFiled >= q.dateFiledFrom && (q.ssn ? p.ssn4 === q.ssn.slice(-4) : q.ssn4 ? p.ssn4 === q.ssn4 : true));
    if (hits.length > 108_000) throw new PermanentRejection("RESULT_LIMIT", "batch results exceed 108,000");
    const reportId = `R${this.reports.size + 1}`;
    this.reports.set(reportId, hits); return { reportId };
  }
  async reportStatus(reportId: string): Promise<"running" | "complete" | "failed"> { this.check(); return this.reports.has(reportId) ? "complete" : "failed"; }
  async reportDownload(reportId: string): Promise<readonly PacerParty[]> { this.check(); const r = this.reports.get(reportId); if (!r) throw new PermanentRejection("NO_REPORT", reportId); return r; }
  async deleteReport(reportId: string): Promise<void> { this.check(); this.reports.delete(reportId); }
  async docket(caseNumber: string, since: string): Promise<readonly { seq: number; filedOn: string; kind: string; text: string }[]> { this.check(); return (this.dockets.get(caseNumber) ?? []).filter((d) => d.filedOn >= since); }
}
/** 14.1 matching rule: a hit is accepted when SSN4 + last name match (full SSN with last name also allowed). */
export function pacerMatchAccepted(hit: PacerParty, borrower: { lastName: string; ssn4: string }): boolean {
  return hit.lastName.toLowerCase() === borrower.lastName.toLowerCase() && hit.ssn4 === borrower.ssn4;
}

export type DmdcStatus = "active_duty" | "not_active" | "X" | "Z";
export interface DmdcRequest { readonly requestId: string; readonly lastName: string; readonly firstName: string; readonly dob?: string; readonly ssn?: string; readonly activeDutyStatusDate: string; }
export interface DmdcResult { readonly requestId: string; readonly status: DmdcStatus; readonly certificateId?: string; readonly serviceStart?: string; readonly serviceEnd?: string; readonly certificateSha256?: string; }
export interface DmdcPort {
  /** Batch upload is portal-only: returns the package for a `human_portal_task{kind=dmdc_batch_upload}`; results come back through `ingestResults`. */
  buildBatch(requests: readonly DmdcRequest[], now: string): Promise<{ batchId: string; fileName: string; content: string; rows: number }>;
  ingestResults(batchId: string, zipContent: string): Promise<readonly DmdcResult[]>;
  singleLookup(r: DmdcRequest): Promise<DmdcResult>;
}
export class FakeDmdc implements DmdcPort {
  outage = false;
  readonly batches = new Map<string, readonly DmdcRequest[]>();
  readonly activeDuty = new Map<string, { start: string; end: string | null }>();   // key: lastName|ssnLast4
  readonly mismatchNames = new Set<string>();
  private check(): void { if (this.outage) throw new AdapterUnavailable("dmdc", "postpone_sale_pending_dmdc"); }
  private statusFor(r: DmdcRequest): DmdcResult {
    const key = `${r.lastName.toLowerCase()}|${(r.ssn ?? "").slice(-4)}`;
    if (this.mismatchNames.has(r.lastName.toLowerCase())) return { requestId: r.requestId, status: "Z" };
    const a = this.activeDuty.get(key);
    if (!a) return { requestId: r.requestId, status: "not_active", certificateId: `CERT-${r.requestId}`, certificateSha256: "0".repeat(64) };
    if (a.start <= r.activeDutyStatusDate && (a.end === null || a.end >= r.activeDutyStatusDate)) return { requestId: r.requestId, status: "active_duty", certificateId: `CERT-${r.requestId}`, serviceStart: a.start, ...(a.end ? { serviceEnd: a.end } : {}), certificateSha256: "1".repeat(64) };
    return { requestId: r.requestId, status: "X", certificateId: `CERT-${r.requestId}` };
  }
  async buildBatch(requests: readonly DmdcRequest[], now: string): Promise<{ batchId: string; fileName: string; content: string; rows: number }> {
    const batchId = `DMDC-${now.slice(0, 10)}-${this.batches.size + 1}`;
    this.batches.set(batchId, requests);
    const content = requests.map((r) => [r.requestId, r.lastName, r.firstName, r.dob ?? "", r.ssn ?? "", r.activeDutyStatusDate].join("|")).join("\n");
    return { batchId, fileName: `${batchId}.txt`, content, rows: requests.length };
  }
  async ingestResults(batchId: string, _zip: string): Promise<readonly DmdcResult[]> { const reqs = this.batches.get(batchId); if (!reqs) throw new PermanentRejection("NO_BATCH", batchId); return reqs.map((r) => this.statusFor(r)); }
  async singleLookup(r: DmdcRequest): Promise<DmdcResult> { this.check(); return this.statusFor(r); }
}
/** 13.8: X (status date reported but not on duty on that date) and Z (name/DOB mismatch) are "unknown" → retry with alternates; unresolved → no affidavit, attorney decides. */
export function dmdcOutcome(r: DmdcResult): "protected" | "clear" | "unknown" { return r.status === "active_duty" ? "protected" : r.status === "not_active" ? "clear" : "unknown"; }

export type ErecordingStatus = "created" | "submitted" | "accepted" | "recorded" | "rejected";
export interface ErecordingPackage { readonly packageId: string; readonly releaseTaskId: string; readonly attempt: number; readonly county: string; readonly state: string; readonly documentSha256: string; status: ErecordingStatus; rejectReason?: string; recordedAt?: string; instrumentNumber?: string; recordedImageSha256?: string; feeCents?: bigint; }
export interface ErecordingPort {
  createPackage(p: { releaseTaskId: string; attempt: number; county: string; state: string; documentSha256: string }, now: string): Promise<ErecordingPackage & { duplicate: boolean }>;
  submit(packageId: string, now: string): Promise<ErecordingPackage>;
  status(packageId: string): Promise<ErecordingPackage>;
  countyCovered(state: string, county: string): Promise<boolean>;
}
export class FakeErecording implements ErecordingPort {
  outage = false;
  readonly packages = new Map<string, ErecordingPackage>();
  readonly coverage = new Set<string>(["TX:Dallas", "TX:Harris", "CA:Los Angeles", "FL:Miami-Dade", "NY:Kings"]);
  rejectFor: (p: ErecordingPackage) => string | null = () => null;
  recordingFeeCents = 3_400n;
  private check(): void { if (this.outage) throw new AdapterUnavailable("erecording", "paper_recording_by_mail"); }
  async createPackage(p: { releaseTaskId: string; attempt: number; county: string; state: string; documentSha256: string }, _now: string): Promise<ErecordingPackage & { duplicate: boolean }> {
    this.check();
    const packageId = `${p.releaseTaskId}#${p.attempt}`;
    const existing = this.packages.get(packageId);
    if (existing) return { ...existing, duplicate: true };
    if (!this.coverage.has(`${p.state}:${p.county}`)) throw new PermanentRejection("COUNTY_NOT_COVERED", `${p.county}, ${p.state} is not an e-recording county`);
    const pkg: ErecordingPackage = { packageId, ...p, status: "created" };
    this.packages.set(packageId, pkg); return { ...pkg, duplicate: false };
  }
  async submit(packageId: string, now: string): Promise<ErecordingPackage> {
    this.check();
    const pkg = this.packages.get(packageId); if (!pkg) throw new PermanentRejection("NO_PACKAGE", packageId);
    if (pkg.status !== "created") return pkg;
    const reject = this.rejectFor(pkg);
    if (reject) { pkg.status = "rejected"; pkg.rejectReason = reject; return pkg; }
    pkg.status = "recorded"; pkg.recordedAt = now; pkg.instrumentNumber = `${now.slice(0, 4)}-${packageId.replace(/\W/g, "")}`; pkg.recordedImageSha256 = "r".repeat(64); pkg.feeCents = this.recordingFeeCents;
    return pkg;
  }
  async status(packageId: string): Promise<ErecordingPackage> { this.check(); const p = this.packages.get(packageId); if (!p) throw new PermanentRejection("NO_PACKAGE", packageId); return p; }
  async countyCovered(state: string, county: string): Promise<boolean> { return this.coverage.has(`${state}:${county}`); }
}

// ───────────────────────────── the law firm (35.9 rule 8: "A firm is an outbox counterparty") ─────────────────────────────
/**
 * The `law-firm` port: outbound dispatches (referral packages, instructions, messages, documents, invoice responses) and the
 * inbound replies a firm sends (acknowledgments, document requests, milestone reports, sale events, invoices, the daily DRA
 * snapshot). In production the same port is the attorney-network / case-management vendor feed [UNVERIFIED — vendor-specific;
 * only the FAKE is built]; nothing in the domain knows which.
 */
export interface FirmDispatchMessage {
  readonly dispatch_id: string; readonly loan_id: string; readonly case_id: string | null; readonly firm_id: string;
  readonly kind: "referral_package" | "instruction" | "message" | "documents" | "invoice_response" | "status_demand" | "ack_demand";
  readonly owning_event_id: string | null;
  /** The date of the owning event (the referral's `sent_at`): the FAKE's replies are a pure function of it, never of delivery time (35.9-T14). */
  readonly owning_event_on: string;
  readonly state: string; readonly method: "judicial" | "non_judicial";
  readonly payload: Record<string, unknown>;
}
export interface FirmReply { readonly reply_id: string; readonly kind: "ack" | "document_request" | "milestone" | "sale" | "invoice" | "dra_snapshot"; readonly due_on: string; readonly payload: Record<string, unknown> }
export interface LawFirmPort {
  /** Deliver one dispatch (the outbox adapter's send); a receipt names the firm's message id. */
  deliver(m: FirmDispatchMessage, now: string): Promise<{ firm_message_id: string; accepted: true; at: string }>;
  /** Every reply the firm sends for a dispatch on or before `asOf` — deterministic from the dispatch (the demo advance and a hosted run agree). */
  repliesFor(m: FirmDispatchMessage, asOf: string): readonly FirmReply[];
}
/** Per-state, per-method lead times (calendar days from the referral) the FAKE reports its milestones on — the same demo constants 35.9 seeds as `fc_milestone_defaults` [UNVERIFIED — demo constants]. */
export const FAKE_FIRM_LEADS: Readonly<Record<string, Readonly<Partial<Record<"judicial" | "non_judicial", readonly { code: string; days: number }[]>>>>> = {
  FL: { judicial: [{ code: "FIRST_LEGAL", days: 45 }, { code: "SERVICE_COMPLETE", days: 105 }, { code: "JUDGMENT_ENTERED", days: 345 }, { code: "SALE_SCHEDULED", days: 390 }] },
  NY: { judicial: [{ code: "FIRST_LEGAL", days: 45 }, { code: "SERVICE_COMPLETE", days: 135 }, { code: "JUDGMENT_ENTERED", days: 435 }, { code: "SALE_SCHEDULED", days: 495 }] },
  OH: { judicial: [{ code: "FIRST_LEGAL", days: 45 }, { code: "SERVICE_COMPLETE", days: 105 }, { code: "JUDGMENT_ENTERED", days: 285 }, { code: "SALE_SCHEDULED", days: 330 }] },
  TX: { non_judicial: [{ code: "FIRST_LEGAL", days: 45 }, { code: "SALE_SCHEDULED", days: 66 }] },
  AZ: { non_judicial: [{ code: "FIRST_LEGAL", days: 45 }, { code: "SALE_SCHEDULED", days: 135 }] },
  CA: { non_judicial: [{ code: "FIRST_LEGAL", days: 45 }, { code: "SALE_SCHEDULED", days: 135 }] },
};
const GENERIC_LEADS: readonly { code: string; days: number }[] = [{ code: "FIRST_LEGAL", days: 45 }, { code: "SALE_SCHEDULED", days: 90 }];
const isoDay = (d: string): number => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
const plusDays = (d: string, n: number): string => new Date(isoDay(d) + n * 86_400_000).toISOString().slice(0, 10);
/** The next servicer business day after `d` (weekends only — the FAKE's own calendar; the sections' clocks use the kernel's). */
const nextBusinessDay = (d: string, n: number): string => { let out = d; let left = n; while (left > 0) { out = plusDays(out, 1); const w = new Date(isoDay(out)).getUTCDay(); if (w !== 0 && w !== 6) left -= 1; } return out; };

/**
 * FAKE law firm (35.9 rule 8): acknowledges a referral 1 servicer business day after it was sent with a forecast first-legal
 * date = referral + the state's first_legal lead; answers a document request in 2; reports each milestone on its forecast
 * date; schedules the sale per the state's default. `outage` makes `deliver` throw AdapterUnavailable (the dispatch stays
 * queued; the sections' clocks keep running — 35.9 Integrations). Replies are pure functions of the dispatch, so a demo advance
 * and thirty hosted sweeps produce the same rows.
 */
export class FakeLawFirm implements LawFirmPort {
  outage = false;
  transientRemaining = 0;
  readonly delivered: (FirmDispatchMessage & { at: string })[] = [];
  /** A firm that never acknowledges (a test's late firm): dispatch ids whose replies are withheld. */
  readonly silent = new Set<string>();
  private check(): void { if (this.outage) throw new AdapterUnavailable("law-firm", "law_firm_manual", "attorney network unavailable"); if (this.transientRemaining > 0) { this.transientRemaining -= 1; throw new TransientFailure("law-firm: 502"); } }
  async deliver(m: FirmDispatchMessage, now: string): Promise<{ firm_message_id: string; accepted: true; at: string }> {
    this.check();
    if (!m.firm_id) throw new PermanentRejection("NO_FIRM", "a dispatch names its firm");
    this.delivered.push({ ...m, at: now });
    return { firm_message_id: `FAKE-FIRM-${m.dispatch_id}`, accepted: true, at: now };
  }
  leads(state: string, method: "judicial" | "non_judicial"): readonly { code: string; days: number }[] { return FAKE_FIRM_LEADS[state.toUpperCase()]?.[method] ?? GENERIC_LEADS; }
  repliesFor(m: FirmDispatchMessage, asOf: string): readonly FirmReply[] {
    if (this.silent.has(m.dispatch_id)) return [];
    const day = asOf.slice(0, 10); const out: FirmReply[] = [];
    const push = (kind: FirmReply["kind"], due_on: string, seq: string, payload: Record<string, unknown>): void => { if (due_on <= day) out.push({ reply_id: `firm:${m.dispatch_id}:${kind}:${seq}`, kind, due_on, payload }); };
    if (m.kind === "referral_package") {
      const leads = this.leads(m.state, m.method);
      const firstLegal = leads.find((l) => l.code === "FIRST_LEGAL")?.days ?? 45;
      push("ack", nextBusinessDay(m.owning_event_on, 1), "ack", { referral_id: String(m.payload["referral_id"] ?? ""), complete: true, missing: [], forecast_first_legal_on: plusDays(m.owning_event_on, firstLegal), firm_message_id: `FAKE-FIRM-${m.dispatch_id}` });
      for (const l of leads) {
        const on = plusDays(m.owning_event_on, l.days);
        if (l.code === "SALE_SCHEDULED") push("sale", on, l.code, { sale_at: plusDays(on, 30), method: m.method, scheduled_on: on });
        else push("milestone", on, l.code, { code: l.code, occurred_on: on, source: "firm" });
      }
    }
    if (m.kind === "documents") push("ack", nextBusinessDay(m.owning_event_on, 2), "docs", { request_id: String(m.payload["request_id"] ?? ""), received: true });
    return out;
  }
}
