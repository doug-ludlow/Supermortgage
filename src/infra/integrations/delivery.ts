/**
 * Borrower-facing delivery rails: print/mail (7.x, 9.2 production window),
 * e-delivery (7.4 consent-gated email/portal with bounce → mailed fallback),
 * and telephony/voice (11.1 with answering-machine detection, FCC Reassigned
 * Numbers Database lookups and consent/line-type facts). Every fake records
 * exactly what was sent so notice tests can assert on it.
 */
import { AdapterUnavailable, PermanentRejection, TransientFailure } from "./failures.ts";

export interface MailJob { readonly jobId: string; readonly noticeId: string; readonly template: string; readonly recipient: { name: string; address: string }; readonly pages: number; readonly separateDocument: boolean; readonly envelopeGroup?: string; }
export interface MailJobStatus { readonly jobId: string; status: "received" | "in_production" | "mailed" | "returned" | "cancelled"; productionAt?: string; mailedAt?: string; returnedAt?: string; returnReason?: string; proofOfMailingId?: string; }
export interface PrintMailPort {
  submit(job: MailJob, now: string): Promise<MailJobStatus & { duplicate: boolean }>;
  status(jobId: string): Promise<MailJobStatus>;
  cancel(jobId: string, now: string): Promise<"cancelled" | "too_late">;
  /** Returned-mail feed (NIXIE / undeliverable). */
  returns(since: string): Promise<readonly { jobId: string; noticeId: string; returnedAt: string; reason: string }[]>;
}
export class FakePrintMail implements PrintMailPort {
  outage = false; transientRemaining = 0;
  readonly jobs = new Map<string, MailJobStatus & { job: MailJob }>();
  /** Vendor SLA: pieces enter production the next business morning and mail the same day (policy defaults used by the fake). */
  productionLagMs = 16 * 3_600_000;
  private check(): void { if (this.outage) throw new AdapterUnavailable("print-mail", "print_mail_secondary_vendor"); if (this.transientRemaining > 0) { this.transientRemaining--; throw new TransientFailure("print-mail: SFTP handshake failed"); } }
  async submit(job: MailJob, now: string): Promise<MailJobStatus & { duplicate: boolean }> {
    this.check();
    const existing = this.jobs.get(job.jobId);
    if (existing) return { ...existing, duplicate: true };
    if (!job.recipient.address.trim()) throw new PermanentRejection("ADDRESS_MISSING", `notice ${job.noticeId}: no mailing address`);
    const s: MailJobStatus & { job: MailJob } = { jobId: job.jobId, status: "received", job };
    this.jobs.set(job.jobId, s);
    return { ...s, duplicate: false };
  }
  /** Test hook: the vendor's production run. */
  runProduction(now: string): void {
    for (const s of this.jobs.values()) if (s.status === "received") { s.status = "mailed"; s.productionAt = now; s.mailedAt = now; s.proofOfMailingId = `POM-${s.jobId}`; }
  }
  markReturned(jobId: string, at: string, reason: string): void { const s = this.jobs.get(jobId); if (!s) throw new RangeError(jobId); s.status = "returned"; s.returnedAt = at; s.returnReason = reason; }
  async status(jobId: string): Promise<MailJobStatus> { this.check(); const s = this.jobs.get(jobId); if (!s) throw new PermanentRejection("NO_JOB", jobId); return s; }
  async cancel(jobId: string, now: string): Promise<"cancelled" | "too_late"> { this.check(); const s = this.jobs.get(jobId); if (!s) throw new PermanentRejection("NO_JOB", jobId); if (s.status !== "received") return "too_late"; s.status = "cancelled"; s.returnedAt = now; return "cancelled"; }
  async returns(since: string): Promise<readonly { jobId: string; noticeId: string; returnedAt: string; reason: string }[]> {
    this.check();
    return [...this.jobs.values()].filter((s) => s.status === "returned" && (s.returnedAt ?? "") >= since).map((s) => ({ jobId: s.jobId, noticeId: s.job.noticeId, returnedAt: s.returnedAt!, reason: s.returnReason ?? "" }));
  }
}

export interface EdeliveryMessage { readonly messageId: string; readonly noticeId: string; readonly channel: "email" | "portal" | "sms"; readonly to: string; readonly subject: string; readonly consentId: string; }
export interface EdeliveryStatus { readonly messageId: string; status: "sent" | "delivered" | "bounced" | "opened"; at: string; bounceReason?: string; }
export interface EdeliveryPort {
  send(m: EdeliveryMessage, now: string): Promise<EdeliveryStatus & { duplicate: boolean }>;
  events(since: string): Promise<readonly EdeliveryStatus[]>;
}
export class FakeEdelivery implements EdeliveryPort {
  outage = false;
  readonly messages = new Map<string, EdeliveryStatus & { message: EdeliveryMessage }>();
  /** Addresses that bounce (hard bounce → mailed fallback per 7.4). */
  readonly bouncing = new Set<string>();
  async send(m: EdeliveryMessage, now: string): Promise<EdeliveryStatus & { duplicate: boolean }> {
    if (this.outage) throw new AdapterUnavailable("e-delivery", "print_mail_fallback");
    const existing = this.messages.get(m.messageId);
    if (existing) return { ...existing, duplicate: true };
    if (!m.consentId) throw new PermanentRejection("NO_CONSENT", `notice ${m.noticeId}: electronic delivery without an E-SIGN consent id`);
    const s: EdeliveryStatus & { message: EdeliveryMessage } = this.bouncing.has(m.to) ? { messageId: m.messageId, status: "bounced", at: now, bounceReason: "550 mailbox unavailable", message: m } : { messageId: m.messageId, status: "sent", at: now, message: m };
    this.messages.set(m.messageId, s);
    return { ...s, duplicate: false };
  }
  async events(since: string): Promise<readonly EdeliveryStatus[]> { return [...this.messages.values()].filter((s) => s.at >= since); }
}

export type LineType = "mobile" | "landline" | "voip" | "unknown";
export type CallOutcome = "human_answer" | "machine" | "no_answer" | "busy" | "failed" | "wrong_number";
export interface CallRequest { readonly attemptId: string; readonly to: string; readonly mode: "human_voice" | "ai_voice"; readonly fdcpaDebtCollector: boolean; readonly limitedContentMessage?: string; readonly identifiedMessage?: string; }
export interface CallResult { readonly attemptId: string; readonly outcome: CallOutcome; readonly answeredAt?: string; readonly durationSec: number; readonly messageLeft: "none" | "limited_content" | "identified"; readonly recordingId?: string; }
export interface TelephonyPort {
  dial(req: CallRequest, now: string): Promise<CallResult>;
  lineType(number: string): Promise<LineType>;
  /** FCC Reassigned Numbers Database: was the number reassigned since `consentDate`? */
  reassignedSince(number: string, consentDate: string): Promise<{ reassigned: boolean; checkedAt: string }>;
}
export class FakeTelephony implements TelephonyPort {
  outage = false;
  readonly calls: CallResult[] = [];
  readonly lines = new Map<string, LineType>();
  readonly reassigned = new Map<string, string>();     // number → reassignment date
  outcomeFor: (req: CallRequest) => CallOutcome = () => "no_answer";
  async dial(req: CallRequest, now: string): Promise<CallResult> {
    if (this.outage) throw new AdapterUnavailable("telephony/voice", "human_dialer_failover");
    const outcome = this.outcomeFor(req);
    let messageLeft: CallResult["messageLeft"] = "none";
    if (outcome === "machine") messageLeft = req.fdcpaDebtCollector ? (req.limitedContentMessage ? "limited_content" : "none") : req.identifiedMessage ? "identified" : "none";
    const r: CallResult = { attemptId: req.attemptId, outcome, durationSec: outcome === "human_answer" ? 240 : 0, messageLeft, ...(outcome === "human_answer" ? { answeredAt: now, recordingId: `REC-${req.attemptId}` } : {}) };
    this.calls.push(r); return r;
  }
  async lineType(number: string): Promise<LineType> { if (this.outage) throw new AdapterUnavailable("telephony/voice", "human_dialer_failover"); return this.lines.get(number) ?? "unknown"; }
  async reassignedSince(number: string, consentDate: string): Promise<{ reassigned: boolean; checkedAt: string }> {
    const d = this.reassigned.get(number);
    return { reassigned: d !== undefined && d > consentDate, checkedAt: new Date().toISOString() };
  }
}
