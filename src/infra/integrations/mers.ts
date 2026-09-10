/**
 * MERS (1.5, 16.4). Batch transactions (TOS/TOB/registration/subservicer MIN
 * update/deactivation) with per-transaction accept/reject, pending-transfer
 * notices the counterparty must confirm, the Member Reconciliation Extract,
 * and Rule 7 violation / lockout notices.
 */
import { AdapterUnavailable, PermanentRejection, TransientFailure } from "./failures.ts";

export type MersTxnType = "min_update_subservicer" | "tos_initiate" | "tos_confirm" | "tob_confirm" | "registration" | "deactivation" | "min_update_other" | "lien_release";
export interface MersTxn { readonly txnId: string; readonly min: string; readonly type: MersTxnType; readonly effectiveDate: string; readonly orgId: string; readonly counterpartyOrgId?: string; }
export interface MersTxnResult { readonly txnId: string; readonly status: "accepted" | "rejected" | "pending_confirmation"; readonly rejectCode?: string; readonly message?: string; }
export interface MinSnapshot { readonly min: string; readonly status: "active" | "inactive" | "deactivated"; readonly servicerOrgId: string; readonly subservicerOrgId: string | null; readonly investorOrgId: string; readonly noteOwnerOrgId: string; readonly registrationDate: string; readonly mom: boolean; }

export interface MersPort {
  queryMin(min: string): Promise<MinSnapshot | null>;
  submitBatch(txns: readonly MersTxn[], now: string): Promise<{ batchId: string; results: readonly MersTxnResult[] }>;
  pendingTransfers(orgId: string): Promise<readonly { min: string; fromOrgId: string; type: "tos" | "tob"; noticedAt: string }[]>;
  memberReconciliationExtract(orgId: string, asOf: string): Promise<readonly MinSnapshot[]>;
}

export const FANNIE_MAE_ORG_ID = "1000010";
const MIN_RE = /^\d{18}$/;

/** MIN check digit (Mod 10 over the 17-digit body, MERS Procedures). */
export function minCheckDigitOk(min: string): boolean {
  if (!MIN_RE.test(min)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) { let d = Number(min[16 - i]); if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; } sum += d; }
  return (10 - (sum % 10)) % 10 === Number(min[17]);
}

export class FakeMers implements MersPort {
  outage = false;
  transientRemaining = 0;
  readonly registry = new Map<string, MinSnapshot>();
  readonly pending: { min: string; fromOrgId: string; type: "tos" | "tob"; noticedAt: string; toOrgId: string }[] = [];
  readonly batches: { batchId: string; txns: readonly MersTxn[]; results: MersTxnResult[] }[] = [];
  private check(): void { if (this.outage) throw new AdapterUnavailable("mers", "mers_online_entry"); if (this.transientRemaining > 0) { this.transientRemaining--; throw new TransientFailure("mers: batch gateway timeout"); } }
  register(s: MinSnapshot): void { this.registry.set(s.min, s); }
  async queryMin(min: string): Promise<MinSnapshot | null> { this.check(); return this.registry.get(min) ?? null; }
  async submitBatch(txns: readonly MersTxn[], now: string): Promise<{ batchId: string; results: readonly MersTxnResult[] }> {
    this.check();
    const results: MersTxnResult[] = txns.map((t): MersTxnResult => {
      if (!minCheckDigitOk(t.min)) return { txnId: t.txnId, status: "rejected", rejectCode: "MIN_INVALID", message: "MIN fails format/check digit" };
      const snap = this.registry.get(t.min);
      if (t.type === "registration") {
        if (snap) return { txnId: t.txnId, status: "rejected", rejectCode: "ALREADY_REGISTERED", message: "MIN already registered" };
        this.registry.set(t.min, { min: t.min, status: "active", servicerOrgId: t.orgId, subservicerOrgId: null, investorOrgId: t.counterpartyOrgId ?? FANNIE_MAE_ORG_ID, noteOwnerOrgId: t.counterpartyOrgId ?? FANNIE_MAE_ORG_ID, registrationDate: t.effectiveDate, mom: true });
        return { txnId: t.txnId, status: "accepted" };
      }
      if (!snap) return { txnId: t.txnId, status: "rejected", rejectCode: "MIN_NOT_FOUND", message: "MIN not registered" };
      if (snap.status !== "active") return { txnId: t.txnId, status: "rejected", rejectCode: "MIN_INACTIVE", message: `MIN is ${snap.status}` };
      switch (t.type) {
        case "min_update_subservicer": this.registry.set(t.min, { ...snap, subservicerOrgId: t.orgId }); return { txnId: t.txnId, status: "accepted" };
        case "tos_initiate": {
          if (snap.servicerOrgId !== t.orgId) return { txnId: t.txnId, status: "rejected", rejectCode: "NOT_SERVICER", message: "only the current Servicer may initiate a TOS" };
          this.pending.push({ min: t.min, fromOrgId: t.orgId, type: "tos", noticedAt: now, toOrgId: t.counterpartyOrgId ?? "" });
          return { txnId: t.txnId, status: "pending_confirmation" };
        }
        case "tos_confirm": {
          const i = this.pending.findIndex((p) => p.min === t.min && p.type === "tos" && p.toOrgId === t.orgId);
          if (i < 0) return { txnId: t.txnId, status: "rejected", rejectCode: "NO_PENDING_TOS", message: "no pending TOS for this org" };
          this.pending.splice(i, 1); this.registry.set(t.min, { ...snap, servicerOrgId: t.orgId, subservicerOrgId: null }); return { txnId: t.txnId, status: "accepted" };
        }
        case "tob_confirm": this.registry.set(t.min, { ...snap, investorOrgId: t.orgId, noteOwnerOrgId: t.orgId }); return { txnId: t.txnId, status: "accepted" };
        case "deactivation": this.registry.set(t.min, { ...snap, status: "deactivated" }); return { txnId: t.txnId, status: "accepted" };
        case "lien_release": this.registry.set(t.min, { ...snap, status: "inactive" }); return { txnId: t.txnId, status: "accepted" };
        case "min_update_other": return { txnId: t.txnId, status: "accepted" };
      }
    });
    const batchId = `MERS-B${this.batches.length + 1}`;
    this.batches.push({ batchId, txns, results });
    return { batchId, results };
  }
  async pendingTransfers(orgId: string): Promise<readonly { min: string; fromOrgId: string; type: "tos" | "tob"; noticedAt: string }[]> { this.check(); return this.pending.filter((p) => p.toOrgId === orgId).map(({ toOrgId: _t, ...p }) => p); }
  async memberReconciliationExtract(orgId: string, _asOf: string): Promise<readonly MinSnapshot[]> { this.check(); return [...this.registry.values()].filter((s) => s.servicerOrgId === orgId || s.subservicerOrgId === orgId); }
}

/** 1.5 post-transfer verification: Servicer = partner, Subservicer = Supermortgage, Investor = Fannie Mae. */
export function verifyPostTransfer(s: MinSnapshot, partnerOrgId: string, supermortgageOrgId: string): string[] {
  const issues: string[] = [];
  if (s.status !== "active") issues.push(`MIN ${s.min} is ${s.status}`);
  if (s.servicerOrgId !== partnerOrgId) issues.push(`servicer ${s.servicerOrgId} ≠ partner ${partnerOrgId}`);
  if (s.subservicerOrgId !== supermortgageOrgId) issues.push(`subservicer ${s.subservicerOrgId ?? "none"} ≠ ${supermortgageOrgId}`);
  if (s.investorOrgId !== FANNIE_MAE_ORG_ID) issues.push(`investor ${s.investorOrgId} ≠ Fannie Mae ${FANNIE_MAE_ORG_ID}`);
  return issues;
}
export { PermanentRejection as MersRejection };
