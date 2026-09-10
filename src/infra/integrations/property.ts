/**
 * Property and insurance rails: insurance tracking / lender-placed (9.1–9.5),
 * flood determination and life-of-loan monitoring (9.6), tax service (3.7)
 * and mortgage insurers (10.x, 15.3). Idempotency keys follow the spec:
 * LPI = (vendor loan id, policy id, message type, vendor sequence); flood =
 * vendor certificate id. A flood-vendor outage may use FEMA NFHL only as a
 * screening cross-check, never as a determination.
 */
import { AdapterUnavailable, PermanentRejection } from "./failures.ts";

export type PolicyMessageType = "policy_snapshot" | "eoi" | "cancellation" | "non_renewal" | "reinstatement" | "rating_update";
export interface PolicyMessage { readonly vendorLoanId: string; readonly policyId: string; readonly type: PolicyMessageType; readonly vendorSequence: number; readonly carrier: string; readonly coverageCents: bigint; readonly deductibleCents: bigint; readonly effectiveOn: string; readonly expiresOn: string; readonly documentSha256?: string; readonly cancelledOn?: string; }
export interface LpiBinding { readonly bindingId: string; readonly vendorLoanId: string; readonly coverageCents: bigint; readonly effectiveOn: string; readonly annualPremiumCents: bigint; readonly cancelledOn?: string; readonly refundCents?: bigint; }
export interface LpiTrackingPort {
  /** Outbound daily loan/property/mortgagee file (adds, removals, address/escrow/occupancy/claim changes). */
  sendLoanFile(rows: readonly Record<string, string>[], asOf: string): Promise<{ fileId: string; duplicate: boolean }>;
  inbound(since: string): Promise<readonly PolicyMessage[]>;
  bind(vendorLoanId: string, coverageCents: bigint, effectiveOn: string, now: string): Promise<LpiBinding>;
  cancel(bindingId: string, cancelledOn: string, now: string): Promise<LpiBinding>;
}
export class FakeLpiTracking implements LpiTrackingPort {
  outage = false;
  readonly files = new Map<string, string>();
  readonly queue: PolicyMessage[] = [];
  readonly bindings = new Map<string, LpiBinding>();
  readonly seen = new Set<string>();
  annualRateBps = 250;   // premium = coverage × rate (fake)
  private check(): void { if (this.outage) throw new AdapterUnavailable("insurance-tracking/lpi", "vendor_portal_lookup"); }
  post(m: PolicyMessage): void { this.queue.push(m); }
  async sendLoanFile(rows: readonly Record<string, string>[], asOf: string): Promise<{ fileId: string; duplicate: boolean }> {
    this.check();
    const fileId = `LPI-${asOf}`; const body = JSON.stringify(rows);
    if (this.files.get(fileId) === body) return { fileId, duplicate: true };
    this.files.set(fileId, body); return { fileId, duplicate: false };
  }
  /** Delivers each (vendor loan, policy, type, sequence) once — replays are dropped (spec idempotency key). */
  async inbound(_since: string): Promise<readonly PolicyMessage[]> {
    this.check();
    const out: PolicyMessage[] = [];
    for (const m of this.queue.splice(0)) { const k = `${m.vendorLoanId}|${m.policyId}|${m.type}|${m.vendorSequence}`; if (this.seen.has(k)) continue; this.seen.add(k); out.push(m); }
    return out;
  }
  async bind(vendorLoanId: string, coverageCents: bigint, effectiveOn: string, _now: string): Promise<LpiBinding> {
    this.check();
    const open = [...this.bindings.values()].find((b) => b.vendorLoanId === vendorLoanId && !b.cancelledOn);
    if (open) throw new PermanentRejection("ALREADY_BOUND", `${vendorLoanId} already has LPI binding ${open.bindingId}`);
    const b: LpiBinding = { bindingId: `LPI-B${this.bindings.size + 1}`, vendorLoanId, coverageCents, effectiveOn, annualPremiumCents: coverageCents * BigInt(this.annualRateBps) / 10_000n };
    this.bindings.set(b.bindingId, b); return b;
  }
  async cancel(bindingId: string, cancelledOn: string, _now: string): Promise<LpiBinding> {
    this.check();
    const b = this.bindings.get(bindingId); if (!b) throw new PermanentRejection("NO_BINDING", bindingId);
    if (b.cancelledOn) return b;
    const days = Math.max(0, Math.round((Date.parse(cancelledOn) - Date.parse(b.effectiveOn)) / 86_400_000));
    const earned = b.annualPremiumCents * BigInt(Math.min(days, 365)) / 365n;
    const next = { ...b, cancelledOn, refundCents: b.annualPremiumCents - earned };
    this.bindings.set(bindingId, next); return next;
  }
}

export interface FloodDetermination { readonly certificateId: string; readonly propertyId: string; readonly sfha: boolean; readonly zone: string; readonly communityNumber: string; readonly mapPanel: string; readonly determinedOn: string; readonly lifeOfLoan: boolean; readonly documentSha256?: string; }
export interface FloodPort {
  orderDetermination(propertyId: string, address: string, now: string): Promise<FloodDetermination>;
  enrollLifeOfLoan(certificateId: string): Promise<{ enrolled: true }>;
  transferLifeOfLoan(certificateId: string, toServicerId: string): Promise<{ transferred: true }>;
  mapChanges(since: string): Promise<readonly { certificateId: string; propertyId: string; newZone: string; sfha: boolean; effectiveOn: string }[]>;
  /** Heartbeat for FLOOD_LOL_HEARTBEAT_35 — any vendor message counts. */
  lastMessageAt(): Promise<string | null>;
}
export class FakeFlood implements FloodPort {
  outage = false;
  readonly determinations = new Map<string, FloodDetermination>();
  readonly byProperty = new Map<string, string>();
  readonly enrolled = new Set<string>();
  private readonly changes: { certificateId: string; propertyId: string; newZone: string; sfha: boolean; effectiveOn: string; at: string }[] = [];
  private last: string | null = null;
  zoneFor: (address: string) => { zone: string; sfha: boolean } = () => ({ zone: "X", sfha: false });
  private check(): void { if (this.outage) throw new AdapterUnavailable("flood", "fema_nfhl_screening_only"); }
  async orderDetermination(propertyId: string, address: string, now: string): Promise<FloodDetermination> {
    this.check();
    const existing = this.byProperty.get(propertyId);
    if (existing) return this.determinations.get(existing)!;    // idempotent by property while the certificate is current
    const z = this.zoneFor(address);
    const d: FloodDetermination = { certificateId: `SFHDF-${this.determinations.size + 1}`, propertyId, sfha: z.sfha, zone: z.zone, communityNumber: "480287", mapPanel: "48113C0345K", determinedOn: now.slice(0, 10), lifeOfLoan: false };
    this.determinations.set(d.certificateId, d); this.byProperty.set(propertyId, d.certificateId); this.last = now; return d;
  }
  async enrollLifeOfLoan(certificateId: string): Promise<{ enrolled: true }> { this.check(); if (!this.determinations.has(certificateId)) throw new PermanentRejection("NO_CERTIFICATE", certificateId); this.enrolled.add(certificateId); return { enrolled: true }; }
  async transferLifeOfLoan(certificateId: string, _to: string): Promise<{ transferred: true }> { this.check(); if (!this.enrolled.has(certificateId)) throw new PermanentRejection("NOT_ENROLLED", certificateId); this.enrolled.delete(certificateId); return { transferred: true }; }
  publishMapChange(certificateId: string, newZone: string, sfha: boolean, effectiveOn: string, at: string): void {
    const d = this.determinations.get(certificateId); if (!d) throw new RangeError(certificateId);
    this.changes.push({ certificateId, propertyId: d.propertyId, newZone, sfha, effectiveOn, at }); this.last = at;
  }
  async mapChanges(since: string): Promise<readonly { certificateId: string; propertyId: string; newZone: string; sfha: boolean; effectiveOn: string }[]> { this.check(); return this.changes.filter((c) => c.at >= since && this.enrolled.has(c.certificateId)).map(({ at: _a, ...c }) => c); }
  async lastMessageAt(): Promise<string | null> { return this.last; }
}
/** During a flood-vendor outage the NFHL cross-check may only screen; it never produces a determination. */
export function nfhlScreeningAllowed(purpose: "screening" | "determination"): boolean { return purpose === "screening"; }

export interface TaxBill { readonly parcelId: string; readonly authority: string; readonly installment: string; readonly amountCents: bigint; readonly dueOn: string; readonly discountOn?: string; readonly discountCents?: bigint; readonly delinquent: boolean; }
export interface TaxServicePort {
  bills(since: string): Promise<readonly TaxBill[]>;
  delete(parcelId: string, reason: "paid_in_full" | "transfer_out" | "foreclosed", now: string): Promise<{ acked: true; duplicate: boolean }>;
  delinquencySearch(parcelId: string): Promise<{ delinquent: boolean; amountCents: bigint; asOf: string }>;
}
export class FakeTaxService implements TaxServicePort {
  outage = false;
  readonly queue: TaxBill[] = [];
  readonly deleted = new Map<string, string>();
  readonly delinquencies = new Map<string, bigint>();
  private check(): void { if (this.outage) throw new AdapterUnavailable("tax-service", "county_site_lookup"); }
  async bills(_since: string): Promise<readonly TaxBill[]> { this.check(); return this.queue.splice(0); }
  async delete(parcelId: string, reason: "paid_in_full" | "transfer_out" | "foreclosed", now: string): Promise<{ acked: true; duplicate: boolean }> { this.check(); const dup = this.deleted.has(parcelId); if (!dup) this.deleted.set(parcelId, `${reason}@${now}`); return { acked: true, duplicate: dup }; }
  async delinquencySearch(parcelId: string): Promise<{ delinquent: boolean; amountCents: bigint; asOf: string }> { this.check(); const a = this.delinquencies.get(parcelId) ?? 0n; return { delinquent: a > 0n, amountCents: a, asOf: new Date().toISOString().slice(0, 10) }; }
}

export type MiDecision = "approved" | "denied" | "curtailed" | "rescinded" | "pending";
export interface MiPort {
  requestCancellation(certificate: string, reason: "borrower_request" | "automatic_78" | "midpoint" | "investor", effectiveOn: string, now: string): Promise<{ requestId: string; status: "accepted" | "rejected"; message?: string }>;
  notifyDefault(certificate: string, firstUnpaidDueDate: string, now: string): Promise<{ acked: true }>;
  monthlyStatus(certificate: string, asOf: string, status: Record<string, string>): Promise<{ acked: true }>;
  fileClaim(certificate: string, claimId: string, lines: readonly Record<string, unknown>[], now: string): Promise<{ claimId: string; status: MiDecision; duplicate: boolean }>;
  claimStatus(claimId: string): Promise<{ claimId: string; status: MiDecision; benefitCents?: bigint; explanation?: string }>;
  refunds(since: string): Promise<readonly { certificate: string; refundCents: bigint; reason: string; receivedOn: string }[]>;
}
export class FakeMi implements MiPort {
  outage = false;
  readonly cancellations: { requestId: string; certificate: string; reason: string; effectiveOn: string }[] = [];
  readonly defaults = new Map<string, string>();
  readonly statuses: { certificate: string; asOf: string; status: Record<string, string> }[] = [];
  readonly claims = new Map<string, { certificate: string; status: MiDecision; benefitCents?: bigint; explanation?: string; lines: readonly Record<string, unknown>[] }>();
  readonly refundQueue: { certificate: string; refundCents: bigint; reason: string; receivedOn: string }[] = [];
  readonly certificates = new Set<string>();
  private check(): void { if (this.outage) throw new AdapterUnavailable("mi/*", "mi_portal_entry"); }
  async requestCancellation(certificate: string, reason: "borrower_request" | "automatic_78" | "midpoint" | "investor", effectiveOn: string, _now: string): Promise<{ requestId: string; status: "accepted" | "rejected"; message?: string }> {
    this.check();
    if (!this.certificates.has(certificate)) return { requestId: "", status: "rejected", message: "unknown certificate" };
    const requestId = `MI-C${this.cancellations.length + 1}`;
    this.cancellations.push({ requestId, certificate, reason, effectiveOn });
    return { requestId, status: "accepted" };
  }
  async notifyDefault(certificate: string, firstUnpaidDueDate: string, _now: string): Promise<{ acked: true }> { this.check(); if (!this.defaults.has(certificate)) this.defaults.set(certificate, firstUnpaidDueDate); return { acked: true }; }
  async monthlyStatus(certificate: string, asOf: string, status: Record<string, string>): Promise<{ acked: true }> { this.check(); this.statuses.push({ certificate, asOf, status }); return { acked: true }; }
  async fileClaim(certificate: string, claimId: string, lines: readonly Record<string, unknown>[], _now: string): Promise<{ claimId: string; status: MiDecision; duplicate: boolean }> {
    this.check();
    const existing = this.claims.get(claimId);
    if (existing) return { claimId, status: existing.status, duplicate: true };
    if (!this.defaults.has(certificate)) throw new PermanentRejection("NO_NOD", `claim ${claimId}: no notice of default on file for ${certificate}`);
    this.claims.set(claimId, { certificate, status: "pending", lines });
    return { claimId, status: "pending", duplicate: false };
  }
  decide(claimId: string, status: MiDecision, benefitCents?: bigint, explanation?: string): void { const c = this.claims.get(claimId); if (!c) throw new RangeError(claimId); c.status = status; if (benefitCents !== undefined) c.benefitCents = benefitCents; if (explanation) c.explanation = explanation; }
  async claimStatus(claimId: string): Promise<{ claimId: string; status: MiDecision; benefitCents?: bigint; explanation?: string }> { this.check(); const c = this.claims.get(claimId); if (!c) throw new PermanentRejection("NO_CLAIM", claimId); return { claimId, status: c.status, ...(c.benefitCents !== undefined ? { benefitCents: c.benefitCents } : {}), ...(c.explanation ? { explanation: c.explanation } : {}) }; }
  async refunds(since: string): Promise<readonly { certificate: string; refundCents: bigint; reason: string; receivedOn: string }[]> { this.check(); return this.refundQueue.filter((r) => r.receivedOn >= since); }
}
