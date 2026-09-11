/**
 * Credit reporting rails (8.1/8.2): Metro 2 transmission with one transport
 * per bureau and an acknowledgment per file, and e-OSCAR's ACDV/AUD REST
 * flow (validate before submit; an outage with a response due within 3 days
 * becomes a web-app task for a human — 8.2-T11).
 */
import { createHash } from "node:crypto";
import { AdapterUnavailable, PermanentRejection, TransientFailure } from "./failures.ts";

export type Bureau = "experian" | "transunion" | "equifax" | "innovis";
export const BUREAU_TRANSPORT: Record<Bureau, string> = { experian: "STS", transunion: "EDT", equifax: "SFTP", innovis: "SFTP [UNVERIFIED transport]" };
export interface Metro2Ack { readonly bureau: Bureau; readonly fileId: string; readonly status: "accepted" | "accepted_with_errors" | "rejected"; readonly errors: readonly { line: number; code: string; message: string }[]; readonly ackedAt: string; }
export interface Metro2Port { transmit(bureau: Bureau, fileName: string, content: string, now: string): Promise<{ fileId: string; duplicate: boolean }>; ack(bureau: Bureau, fileId: string): Promise<Metro2Ack | null>; }

export class FakeMetro2 implements Metro2Port {
  readonly outages = new Set<Bureau>();
  readonly files = new Map<string, { bureau: Bureau; fileName: string; content: string; at: string }>();
  ackDelayMs = 0;
  errorsFor: (bureau: Bureau, content: string) => { line: number; code: string; message: string }[] = () => [];
  async transmit(bureau: Bureau, fileName: string, content: string, now: string): Promise<{ fileId: string; duplicate: boolean }> {
    if (this.outages.has(bureau)) throw new AdapterUnavailable(`metro2/${bureau}`, "bureau_portal_upload");
    const fileId = `${bureau}:${createHash("sha256").update(content).digest("hex").slice(0, 12)}`;
    if (this.files.has(fileId)) return { fileId, duplicate: true };
    const lines = content.split(/\r?\n/).filter(Boolean);
    if (!lines[0]?.startsWith("HEADER") || !lines.at(-1)?.startsWith("TRAILER")) throw new PermanentRejection("METRO2_STRUCTURE", "file must start with a HEADER and end with a TRAILER record");
    this.files.set(fileId, { bureau, fileName, content, at: now });
    return { fileId, duplicate: false };
  }
  async ack(bureau: Bureau, fileId: string): Promise<Metro2Ack | null> {
    const f = this.files.get(fileId); if (!f || f.bureau !== bureau) return null;
    const errors = this.errorsFor(bureau, f.content);
    return { bureau, fileId, status: errors.length === 0 ? "accepted" : errors.length < 10 ? "accepted_with_errors" : "rejected", errors, ackedAt: new Date(Date.parse(f.at) + this.ackDelayMs).toISOString() };
  }
}

export interface Acdv { readonly controlNumber: string; readonly bureau: Bureau; readonly consumer: { name: string; ssnLast4: string }; readonly accountNumber: string; readonly disputeCodes: readonly string[]; readonly receivedAt: string; readonly responseDueOn: string; readonly images: readonly string[]; readonly fcraRelevantInfo: boolean; }
export interface AcdvResponse { readonly controlNumber: string; readonly responseCode: string; readonly accountFields: Record<string, string>; readonly complianceConditionCode?: string; readonly narrative?: string; }
export interface Aud { readonly audId: string; readonly bureau: Bureau; readonly accountNumber: string; readonly fields: Record<string, string>; readonly reason: string; }
export interface EoscarPort {
  findAcdvs(since: string): Promise<readonly Acdv[]>;
  viewAcdv(controlNumber: string): Promise<Acdv>;
  validateAcdvResponse(r: AcdvResponse): Promise<{ valid: boolean; errors: readonly string[] }>;
  submitAcdvResponse(r: AcdvResponse, now: string): Promise<{ controlNumber: string; submittedAt: string; duplicate: boolean }>;
  validateAud(a: Aud): Promise<{ valid: boolean; errors: readonly string[] }>;
  submitAud(a: Aud, now: string): Promise<{ audId: string; submittedAt: string; duplicate: boolean }>;
}
const RESPONSE_CODES = new Set(["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27"]);
export class FakeEoscar implements EoscarPort {
  outage = false; transientRemaining = 0;
  readonly inbox = new Map<string, Acdv>();
  readonly responses = new Map<string, { r: AcdvResponse; at: string }>();
  readonly auds = new Map<string, { a: Aud; at: string }>();
  private check(): void { if (this.outage) throw new AdapterUnavailable("e-oscar", "eoscar_web_entry"); if (this.transientRemaining > 0) { this.transientRemaining--; throw new TransientFailure("e-oscar: 503"); } }
  post(a: Acdv): void { this.inbox.set(a.controlNumber, a); }
  async findAcdvs(since: string): Promise<readonly Acdv[]> { this.check(); return [...this.inbox.values()].filter((a) => a.receivedAt >= since && !this.responses.has(a.controlNumber)); }
  async viewAcdv(controlNumber: string): Promise<Acdv> { this.check(); const a = this.inbox.get(controlNumber); if (!a) throw new PermanentRejection("NO_ACDV", controlNumber); return a; }
  async validateAcdvResponse(r: AcdvResponse): Promise<{ valid: boolean; errors: readonly string[] }> {
    this.check();
    const errors: string[] = [];
    if (!this.inbox.has(r.controlNumber)) errors.push("unknown control number");
    if (!RESPONSE_CODES.has(r.responseCode)) errors.push(`response code ${r.responseCode} not in the ACDV response code table`);
    if (r.responseCode !== "01" && Object.keys(r.accountFields).length === 0) errors.push("a modifying response must carry the corrected account fields");
    return { valid: errors.length === 0, errors };
  }
  async submitAcdvResponse(r: AcdvResponse, now: string): Promise<{ controlNumber: string; submittedAt: string; duplicate: boolean }> {
    this.check();
    const existing = this.responses.get(r.controlNumber);
    if (existing) return { controlNumber: r.controlNumber, submittedAt: existing.at, duplicate: true };
    const v = await this.validateAcdvResponse(r);
    if (!v.valid) throw new PermanentRejection("ACDV_INVALID", v.errors.join("; "), v.errors);
    this.responses.set(r.controlNumber, { r, at: now });
    return { controlNumber: r.controlNumber, submittedAt: now, duplicate: false };
  }
  async validateAud(a: Aud): Promise<{ valid: boolean; errors: readonly string[] }> {
    this.check();
    const errors: string[] = [];
    if (Object.keys(a.fields).length === 0) errors.push("AUD carries no fields");
    if (a.fields["create_record"] === "true") errors.push("AUDs may not be used to add or create a record on a consumer's file");
    return { valid: errors.length === 0, errors };
  }
  async submitAud(a: Aud, now: string): Promise<{ audId: string; submittedAt: string; duplicate: boolean }> {
    this.check();
    const existing = this.auds.get(a.audId);
    if (existing) return { audId: a.audId, submittedAt: existing.at, duplicate: true };
    const v = await this.validateAud(a);
    if (!v.valid) throw new PermanentRejection("AUD_INVALID", v.errors.join("; "), v.errors);
    this.auds.set(a.audId, { a, at: now });
    return { audId: a.audId, submittedAt: now, duplicate: false };
  }
}
/** 8.2: during an API outage anything due within 3 days goes to the web app (human); later items wait for the API. */
export function eoscarOutageRouting(responseDueOn: string, today: string): "human_web_app" | "wait_for_api" {
  const days = Math.round((Date.parse(responseDueOn) - Date.parse(today)) / 86_400_000);
  return days <= 3 ? "human_web_app" : "wait_for_api";
}

/**
 * 20.3 rule 2 / 9 and 32.14 S4 (DELTA-13): the consumer-report soft pull that prequalifies a lead — a port with one FAKE
 * adapter, keyed by the 20.3 authorization id (`credit.softpull.requested{idempotency_key}`: one vendor request per
 * authorization, however many times the flow reacts). The FAKE answers deterministically from the SSN's last four digits
 * (the SSN itself never reaches a vendor fake): a representative Classic FICO score across 20.4's tier bands, a frozen
 * file for a last-4 ending in `00` (lift instructions, never an adverse inference — 20.3 receiveSoftPull) and a fraud
 * alert for one ending in `99`. A real bureau adapter is a new class behind `SoftPullBureauPort`, never an edit to a flow.
 */
export interface SoftPullRequest { readonly authorization_id: string; readonly lead_id: string; readonly ssn_last4: string | null; readonly legal_name?: string | null; readonly date_of_birth?: string | null; readonly address?: string | null; }
export interface SoftPullResult { readonly report_id: string; readonly authorization_id: string; readonly representative_score: number | null; readonly score_model: "classic_fico"; readonly frozen: boolean; readonly fraud_alert: boolean; readonly received_at: string; readonly vendor: string; }
export interface SoftPullBureauPort { readonly vendorName: string; pull(req: SoftPullRequest, now: string): Promise<SoftPullResult>; }
export class FakeSoftPullBureau implements SoftPullBureauPort {
  readonly vendorName = "soft_pull_bureau";
  readonly marker = "FAKE" as const;
  /** Every answer given, by authorization id (idempotent: a second request for the same authorization is the same report). */
  readonly pulls = new Map<string, SoftPullResult>();
  async pull(req: SoftPullRequest, now: string): Promise<SoftPullResult> {
    const prior = this.pulls.get(req.authorization_id); if (prior) return prior;
    const last4 = (req.ssn_last4 ?? "").replace(/\D/g, "").slice(-4);
    const frozen = last4.length === 4 && last4.endsWith("00"); const fraud_alert = last4.length === 4 && last4.endsWith("99");
    const n = last4.length === 4 ? parseInt(last4, 10) : Number.NaN;
    const representative_score = frozen || Number.isNaN(n) ? null : 620 + (n % 200);   // 620 … 819: every 20.4 Classic FICO band from ≤639 to ≥780
    const result: SoftPullResult = { report_id: `rpt-FAKE-${createHash("sha256").update(`${req.authorization_id}|${last4}`).digest("hex").slice(0, 12)}`, authorization_id: req.authorization_id, representative_score, score_model: "classic_fico", frozen, fraud_alert, received_at: now, vendor: "FAKE" };
    this.pulls.set(req.authorization_id, result);
    return result;
  }
}
