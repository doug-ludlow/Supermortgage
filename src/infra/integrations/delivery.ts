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

// ───────────────────────────── 32.14 §4: the telephony vendor's INBOUND webhooks (SMS and voice entry on the same 20.3 lead)
/** An inbound text the vendor posts to POST /v1/webhooks/sms (raw strings — the channel layer normalizes the numbers). */
export interface InboundSms { readonly from: string; readonly to: string; readonly text: string; readonly message_sid: string; }
/** An inbound call leg the vendor posts to POST /v1/webhooks/voice: the first post carries no input; later posts carry keypad digits or a speech result. */
export interface InboundVoice { readonly from: string; readonly to: string; readonly call_sid: string; readonly digits: string | null; readonly speech: string | null; }
/** The inbound side of the telephony/SMS vendor: parse and authenticate its webhook posts (the outbound text goes through `EdeliveryPort` on channel `sms`). */
export interface TelephonyWebhookPort {
  readonly vendorName: string;
  parseSms(rawBody: string, signatureHeader: string | undefined): InboundSms;
  parseVoice(rawBody: string, signatureHeader: string | undefined): InboundVoice;
}
/**
 * FAKE: the vendor signature header `x-fake-telephony` must equal "FAKE" (a real adapter verifies the vendor's HMAC —
 * Twilio's X-Twilio-Signature over the URL + form body); the body is JSON in either the vendor's PascalCase form
 * (From/To/Body/MessageSid, CallSid/Digits/SpeechResult) or snake_case. Every parsed post is logged with `vendor: "FAKE"`.
 */
export class FakeTelephonyWebhooks implements TelephonyWebhookPort {
  readonly vendorName = "FAKE" as const;
  readonly marker = "FAKE" as const;
  readonly log: { vendor: "FAKE"; kind: "sms" | "voice"; from: string; sid: string }[] = [];
  private body(rawBody: string, signatureHeader: string | undefined): Record<string, unknown> {
    if (signatureHeader !== "FAKE") throw new RangeError("x-fake-telephony header must be FAKE for the fake adapter");
    const v = rawBody ? (JSON.parse(rawBody) as unknown) : {};
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new RangeError("the telephony webhook body must be a JSON object");
    return v as Record<string, unknown>;
  }
  private pick(b: Record<string, unknown>, ...keys: string[]): string { for (const k of keys) { const v = b[k]; if (typeof v === "string" && v.trim()) return v.trim(); if (typeof v === "number") return String(v); } return ""; }
  parseSms(rawBody: string, signatureHeader: string | undefined): InboundSms {
    const b = this.body(rawBody, signatureHeader);
    const from = this.pick(b, "from", "From"); const to = this.pick(b, "to", "To"); const text = this.pick(b, "text", "body", "Body");
    if (!from) throw new RangeError("from (the sender's number) is required");
    const message_sid = this.pick(b, "message_sid", "MessageSid", "sid") || `SM_FAKE_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    this.log.push({ vendor: "FAKE", kind: "sms", from, sid: message_sid });
    return { from, to, text, message_sid };
  }
  parseVoice(rawBody: string, signatureHeader: string | undefined): InboundVoice {
    const b = this.body(rawBody, signatureHeader);
    const from = this.pick(b, "from", "From", "caller", "Caller"); const to = this.pick(b, "to", "To", "called", "Called");
    if (!from) throw new RangeError("from (the caller's number) is required");
    const call_sid = this.pick(b, "call_sid", "CallSid") || `CA_FAKE_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    const digits = this.pick(b, "digits", "Digits") || null; const speech = this.pick(b, "speech", "SpeechResult", "speech_result") || null;
    this.log.push({ vendor: "FAKE", kind: "voice", from, sid: call_sid });
    return { from, to, call_sid, digits, speech };
  }
}
