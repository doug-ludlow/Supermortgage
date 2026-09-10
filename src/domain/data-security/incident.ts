/** 19.2 GLBA safeguards — incident clocks, consumer counting, control checks. */
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";

const H = 3600 * 1000, ET = "America/New_York";
export type Severity = "S1" | "S2" | "S3" | "S4";

export interface IncidentClocks { readonly partner_due_ms: number; readonly fnma_due_ms: number; readonly warnings_ms: readonly number[]; readonly assessment_engage_by: PlainDate; readonly assessment_complete_by: PlainDate; }
/** Rule 1/3 — partner 24 h, Fannie Mae Supplement/Form 101 36 h from identification; warnings at 50/75/90 %. */
export function incidentClocks(identifiedMs: number, cal: Calendar = servicer): IncidentClocks {
  const fnma = identifiedMs + 36 * H;
  const date = wallClock(identifiedMs, ET).date;
  const engage = addBusinessDays(date, 10, cal);
  return { partner_due_ms: identifiedMs + 24 * H, fnma_due_ms: fnma, warnings_ms: [0.5, 0.75, 0.9].map((p) => identifiedMs + Math.floor(36 * H * p)), assessment_engage_by: engage, assessment_complete_by: addDays(engage, 76) };
}
export function fnmaReportable(severity: Severity): boolean { return severity === "S1" || severity === "S2"; }
export function timerBreached(dueMs: number, sentMs: number): boolean { return sentMs > dueMs; }
export function nydfsClocks(prongMetMs: number, determinedMs: number | null): { determination_due_ms: number; notice_due_ms: number | null } { return { determination_due_ms: prongMetMs + 48 * H, notice_due_ms: determinedMs === null ? null : determinedMs + 72 * H }; }
export function extortionClocks(paidMs: number): { nydfs_due_ms: number; ftc_or_dfs_30d: PlainDate } { return { nydfs_due_ms: paidMs + 24 * H, ftc_or_dfs_30d: addDays(wallClock(paidMs, ET).date, 30) }; }

export interface ConsumerCount { readonly total: number; readonly unencrypted_or_key_presumed: number; readonly by_state: Readonly<Record<string, number>>; }
export function countConsumers(rows: readonly { id: string; state: string; encrypted: boolean; key_compromised_or_presumed: boolean }[]): ConsumerCount {
  const seen = new Set<string>(); const byState: Record<string, number> = {}; let acquired = 0;
  for (const r of rows) { if (seen.has(r.id)) continue; seen.add(r.id); if (!r.encrypted || r.key_compromised_or_presumed) { acquired++; byState[r.state] = (byState[r.state] ?? 0) + 1; } }
  return { total: seen.size, unencrypted_or_key_presumed: acquired, by_state: byState };
}
/** FTC 314.4(j): ≥ 500 consumers → notice within 30 days of discovery; the anchor never moves when the count is corrected later. */
export function ftcNotice(discoveredOn: PlainDate, consumers: number): { required: boolean; due: PlainDate | null; internal_target: PlainDate | null } {
  if (consumers < 500) return { required: false, due: null, internal_target: null };
  return { required: true, due: addDays(discoveredOn, 30), internal_target: addDays(discoveredOn, 28) };
}
export interface StateRule { readonly consumer_days: number; readonly ag_days: number | null; readonly ag_threshold: number; readonly cra_threshold: number | null; }
export const STATE_BREACH_MATRIX: Readonly<Record<string, StateRule>> = {
  NY: { consumer_days: 30, ag_days: 30, ag_threshold: 1, cra_threshold: 5000 },
  TX: { consumer_days: 60, ag_days: 30, ag_threshold: 250, cra_threshold: 10000 },
};
export function stateNotices(state: string, discoveredOn: PlainDate, residents: number, matrix: Readonly<Record<string, StateRule>> = STATE_BREACH_MATRIX): { consumer_due: PlainDate; ag_due: PlainDate | null; cra_due: PlainDate | null } | { refused: true; escalate: "attorney"; within_minutes: 60 } {
  const r = matrix[state];
  if (!r) return { refused: true, escalate: "attorney", within_minutes: 60 };
  return { consumer_due: addDays(discoveredOn, r.consumer_days), ag_due: r.ag_days !== null && residents >= r.ag_threshold ? addDays(discoveredOn, r.ag_days) : null, cra_due: r.cra_threshold !== null && residents >= r.cra_threshold ? addDays(discoveredOn, r.consumer_days) : null };
}
export function credentialRotation(kind: "system_id" | "human", lastRotatedOn: PlainDate): { due: PlainDate; auto_disable: boolean } { return kind === "system_id" ? { due: addDays(lastRotatedOn, 365), auto_disable: true } : { due: addDays(lastRotatedOn, 90), auto_disable: false }; }
export function vulnSlaMs(detectedMs: number, severity: "critical" | "high" | "medium" | "low", internetFacing: boolean): number {
  const hours = severity === "critical" ? (internetFacing ? 72 : 168) : severity === "high" ? 336 : severity === "medium" ? 720 : 2160;
  return detectedMs + hours * H;
}
export function containmentAllowed(identitiesAffected: number, cisoApproved: boolean): boolean { return identitiesAffected <= 50 || cisoApproved; }
export function nydfsPackage(controls: readonly { id: string; result: "pass" | "fail"; exception_approved: boolean }[]): { kind: "certification" | "acknowledgment_of_noncompliance"; deficient: string[] } {
  const deficient = controls.filter((c) => c.result === "fail" && !c.exception_approved).map((c) => c.id);
  return { kind: deficient.length === 0 ? "certification" : "acknowledgment_of_noncompliance", deficient };
}
export function tlsCipherOk(cipher: string): boolean { return /^TLS_(ECDHE|AES_.*GCM)|ECDHE-.*-GCM/.test(cipher) && /GCM/.test(cipher); }
export function restoreTestResult(tier: 0 | 1 | 2, hoursToRestore: number): "passed" | "failed" { const rto = tier === 0 ? 4 : tier === 1 ? 8 : 24; return hoursToRestore <= rto ? "passed" : "failed"; }
