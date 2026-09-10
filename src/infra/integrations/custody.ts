/**
 * Document custody (1.4, 16.3) and the e-vault. The custodian port carries
 * trial balances, Form 2009 document requests and holdings confirmations
 * (idempotency by batch id + file hash; unacknowledged trial balance re-sent
 * after 2 business days). The e-vault is WORM: a document is stored once
 * under its SHA-256 and can never be overwritten or deleted; `verify`
 * detects tampering on read.
 */
import { createHash } from "node:crypto";
import { AdapterUnavailable, PermanentRejection } from "./failures.ts";

export interface CustodyHolding { readonly fnmaLoanNumber: string; readonly custodianLoanId: string; readonly status: "certified" | "exception" | "released" | "in_transit"; readonly exceptions: readonly string[]; readonly documents: readonly string[]; }
export interface CustodianPort {
  sendTrialBalance(batchId: string, rows: readonly { fnmaLoanNumber: string; noteDate: string; originalUpbCents: bigint }[], now: string): Promise<{ receiptId: string; duplicate: boolean }>;
  holdings(fnmaLoanNumbers: readonly string[]): Promise<readonly CustodyHolding[]>;
  requestDocuments(fnmaLoanNumber: string, form: "2009" | "image", documents: readonly string[], now: string): Promise<{ requestId: string; expectedBy: string }>;
  releaseRequest(fnmaLoanNumber: string, reason: "payoff" | "foreclosure" | "repurchase" | "transfer_out", now: string): Promise<{ releaseId: string }>;
}

export class FakeCustodian implements CustodianPort {
  outage = false;
  readonly holdingsByLoan = new Map<string, CustodyHolding>();
  readonly receipts = new Map<string, string>();
  readonly requests: { requestId: string; fnmaLoanNumber: string; form: string; documents: readonly string[]; at: string }[] = [];
  readonly releases: { releaseId: string; fnmaLoanNumber: string; reason: string; at: string }[] = [];
  turnaroundDays = 5;
  private check(): void { if (this.outage) throw new AdapterUnavailable("custodian", "custodian_manual_status_request"); }
  seed(h: CustodyHolding): void { this.holdingsByLoan.set(h.fnmaLoanNumber, h); }
  async sendTrialBalance(batchId: string, rows: readonly { fnmaLoanNumber: string; noteDate: string; originalUpbCents: bigint }[], now: string): Promise<{ receiptId: string; duplicate: boolean }> {
    this.check();
    const hash = createHash("sha256").update(rows.map((r) => `${r.fnmaLoanNumber}|${r.noteDate}|${r.originalUpbCents}`).join("\n")).digest("hex");
    const key = `${batchId}:${hash}`;
    const existing = this.receipts.get(key);
    if (existing) return { receiptId: existing, duplicate: true };
    const receiptId = `TB-${this.receipts.size + 1}-${now.slice(0, 10)}`;
    this.receipts.set(key, receiptId);
    return { receiptId, duplicate: false };
  }
  async holdings(nums: readonly string[]): Promise<readonly CustodyHolding[]> { this.check(); return nums.map((n) => this.holdingsByLoan.get(n)).filter((h): h is CustodyHolding => h !== undefined); }
  async requestDocuments(fnmaLoanNumber: string, form: "2009" | "image", documents: readonly string[], now: string): Promise<{ requestId: string; expectedBy: string }> {
    this.check();
    if (!this.holdingsByLoan.has(fnmaLoanNumber)) throw new PermanentRejection("NOT_HELD", `custodian holds nothing for ${fnmaLoanNumber}`);
    const requestId = `REQ-${this.requests.length + 1}`;
    this.requests.push({ requestId, fnmaLoanNumber, form, documents, at: now });
    return { requestId, expectedBy: new Date(Date.parse(now) + this.turnaroundDays * 86_400_000).toISOString().slice(0, 10) };
  }
  async releaseRequest(fnmaLoanNumber: string, reason: "payoff" | "foreclosure" | "repurchase" | "transfer_out", now: string): Promise<{ releaseId: string }> {
    this.check();
    const h = this.holdingsByLoan.get(fnmaLoanNumber);
    if (!h) throw new PermanentRejection("NOT_HELD", fnmaLoanNumber);
    if (h.status === "released") throw new PermanentRejection("ALREADY_RELEASED", fnmaLoanNumber);
    this.holdingsByLoan.set(fnmaLoanNumber, { ...h, status: "released" });
    const releaseId = `REL-${this.releases.length + 1}`;
    this.releases.push({ releaseId, fnmaLoanNumber, reason, at: now });
    return { releaseId };
  }
}

export interface StoredDocument { readonly sha256: string; readonly bytes: number; readonly contentType: string; readonly storedAt: string; readonly retentionClass: string; readonly legalHold: boolean; }
export interface EvaultPort {
  store(content: Uint8Array | string, meta: { contentType: string; retentionClass: string }, now: string): Promise<StoredDocument & { duplicate: boolean }>;
  retrieve(sha256: string): Promise<{ content: Uint8Array; meta: StoredDocument } | null>;
  verify(sha256: string): Promise<"intact" | "tampered" | "missing">;
  placeLegalHold(sha256: string): Promise<void>;
  dispose(sha256: string, now: string, retentionExpiredOn: string): Promise<"disposed" | "held" | "missing">;
}

export class WormViolation extends Error { constructor(m: string) { super(m); this.name = "WormViolation"; } }

/** In-memory WORM vault. Real deployments back this with object-lock storage; the contract is the same. */
export class FakeEvault implements EvaultPort {
  private readonly objects = new Map<string, { content: Uint8Array; meta: StoredDocument }>();
  readonly disposals: { sha256: string; at: string }[] = [];
  /** Test hook: corrupt stored bytes without touching the hash, to exercise `verify`. */
  tamper(sha256: string): void { const o = this.objects.get(sha256); if (!o) throw new RangeError(sha256); o.content[0] = (o.content[0]! + 1) & 0xff; }
  async store(content: Uint8Array | string, meta: { contentType: string; retentionClass: string }, now: string): Promise<StoredDocument & { duplicate: boolean }> {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const existing = this.objects.get(sha256);
    if (existing) return { ...existing.meta, duplicate: true };
    const stored: StoredDocument = { sha256, bytes: bytes.length, contentType: meta.contentType, storedAt: now, retentionClass: meta.retentionClass, legalHold: false };
    this.objects.set(sha256, { content: bytes, meta: stored });
    return { ...stored, duplicate: false };
  }
  async retrieve(sha256: string): Promise<{ content: Uint8Array; meta: StoredDocument } | null> { const o = this.objects.get(sha256); return o ? { content: new Uint8Array(o.content), meta: o.meta } : null; }
  async verify(sha256: string): Promise<"intact" | "tampered" | "missing"> {
    const o = this.objects.get(sha256); if (!o) return "missing";
    return createHash("sha256").update(o.content).digest("hex") === sha256 ? "intact" : "tampered";
  }
  async placeLegalHold(sha256: string): Promise<void> { const o = this.objects.get(sha256); if (!o) throw new RangeError(sha256); o.meta = { ...o.meta, legalHold: true }; }
  /** Overwrite is never offered; disposal only after retention expiry and never under legal hold (19.1). */
  async dispose(sha256: string, now: string, retentionExpiredOn: string): Promise<"disposed" | "held" | "missing"> {
    const o = this.objects.get(sha256); if (!o) return "missing";
    if (o.meta.legalHold) return "held";
    if (retentionExpiredOn > now.slice(0, 10)) throw new WormViolation(`retention for ${sha256} runs through ${retentionExpiredOn}`);
    this.objects.delete(sha256); this.disposals.push({ sha256, at: now }); return "disposed";
  }
}
