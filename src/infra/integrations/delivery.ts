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
/** 35.2 rule 9: the outbound manifest file (NDJSON: piece id, notice id, document sha256, mail class, address) the print vendor receives per batch. */
export interface MailManifestFile { readonly manifest_id: string; readonly batch_id: string; readonly vendor: string; readonly submitted_at: string; readonly pieces: readonly { piece_id: string; notice_id: string; attempt_no: number; document_id: string; sha256: string; page_count: number; sheets: number; mail_class: string; separate_envelope: boolean; address: { name: string; address: string } }[]; }
/** 35.2 rule 9: one line of the vendor's proof-of-mailing manifest — matched to the outbound piece by notice_id + attempt_no. */
export interface ProofOfMailing { readonly notice_id: string; readonly attempt_no: number; readonly vendor_piece_id: string; readonly imb: string; readonly mailed_on: string; readonly mailed_at?: string; readonly proof_of_mailing_id: string; readonly batch_id?: string; }
export interface PrintMailPort {
  submit(job: MailJob, now: string): Promise<MailJobStatus & { duplicate: boolean }>;
  /** 35.2: the outbound manifest file for a batch (idempotent on the batch id). */
  submitManifest?(file: MailManifestFile, now: string): Promise<{ vendor_file_id: string; duplicate: boolean }>;
  /** 35.2: the vendor's proof-of-mailing lines for pieces mailed since `since` (a probe of the vendor's reachability on every sweep). */
  manifests?(since: string): Promise<readonly ProofOfMailing[]>;
  status(jobId: string): Promise<MailJobStatus>;
  cancel(jobId: string, now: string): Promise<"cancelled" | "too_late">;
  /** Returned-mail feed (NIXIE / undeliverable). */
  returns(since: string): Promise<readonly { jobId: string; noticeId: string; returnedAt: string; reason: string }[]>;
}
export class FakePrintMail implements PrintMailPort {
  outage = false; transientRemaining = 0;
  readonly jobs = new Map<string, MailJobStatus & { job: MailJob }>();
  /** 35.2: the manifest files received, by batch id (idempotent). */
  readonly manifestFiles = new Map<string, { file: MailManifestFile; at: string; vendor_file_id: string; produced_at?: string }>();
  /** Test hook (35.2 edge case): a proof-of-mailing line the vendor sends that the outbound manifest did not name. */
  readonly injected: ProofOfMailing[] = [];
  injectProofOfMailing(line: ProofOfMailing): void { this.injected.push(line); }
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
  async submitManifest(file: MailManifestFile, now: string): Promise<{ vendor_file_id: string; duplicate: boolean }> {
    this.check();
    const existing = this.manifestFiles.get(file.batch_id); if (existing) return { vendor_file_id: existing.vendor_file_id, duplicate: true };
    const id = `FAKE-MF-${this.manifestFiles.size + 1}`; this.manifestFiles.set(file.batch_id, { file, at: now, vendor_file_id: id });
    return { vendor_file_id: id, duplicate: false };
  }
  /** 35.2: every piece mailed since `since` — the single jobs NoticeService.mail submitted (job id `<notice_id>:<attempt_no>`) and the pieces of every manifest file produced since; the IMB is a fixed 31-digit code per piece. */
  async manifests(since: string): Promise<readonly ProofOfMailing[]> {
    this.check();
    const imbOf = (key: string): string => { const digits = [...key].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 1_000_000_007, 7).toString().padStart(9, "0"); return `00700${digits}${digits}${digits.slice(0, 8)}`; };
    const singles = [...this.jobs.values()].filter((s) => s.status === "mailed" && (s.mailedAt ?? "") >= since).map((s): ProofOfMailing => {
      const [noticeId, attempt] = s.jobId.split(":");
      return { notice_id: noticeId ?? s.job.noticeId, attempt_no: Number(attempt ?? 1) || 1, vendor_piece_id: s.jobId, imb: imbOf(s.jobId), mailed_on: (s.mailedAt ?? since).slice(0, 10), mailed_at: s.mailedAt ?? since, proof_of_mailing_id: s.proofOfMailingId ?? `POM-${s.jobId}` };
    });
    const seen = new Set(singles.map((l) => `${l.notice_id}|${l.attempt_no}`));
    const fromFiles: ProofOfMailing[] = [];
    for (const f of this.manifestFiles.values()) { if (!f.produced_at || f.produced_at < since) continue; for (const p of f.file.pieces) { const key = `${p.notice_id}|${p.attempt_no}`; if (seen.has(key)) continue; seen.add(key); fromFiles.push({ notice_id: p.notice_id, attempt_no: p.attempt_no, vendor_piece_id: `${p.notice_id}:${p.attempt_no}`, imb: imbOf(key), mailed_on: f.produced_at.slice(0, 10), mailed_at: f.produced_at, proof_of_mailing_id: `POM-${f.vendor_file_id}-${p.piece_id}`, batch_id: f.file.batch_id }); } }
    return [...singles, ...fromFiles, ...this.injected.filter((l) => (l.mailed_at ?? `${l.mailed_on}T00:00:00.000Z`) >= since)];
  }
  /** Test hook: the vendor's production run. */
  runProduction(now: string): void {
    for (const s of this.jobs.values()) if (s.status === "received") { s.status = "mailed"; s.productionAt = now; s.mailedAt = now; s.proofOfMailingId = `POM-${s.jobId}`; }
    for (const f of this.manifestFiles.values()) if (!f.produced_at) f.produced_at = now;
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
