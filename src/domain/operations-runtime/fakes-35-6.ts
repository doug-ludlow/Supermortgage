/**
 * §35.6's own FAKE ports (every vendor and every reserved human act is an in-repo FAKE in every build stage): the RON
 * platform's session feed the pass polls (26.2's `FakeRonPlatform` opens sessions but publishes no events — this feed
 * replays the worked example's timeline relative to the scheduled slot), the settlement agent (the requested-net statement,
 * the receipt confirmation, the final settlement statement), the Fannie Mae portal operator (the evidence after the delay),
 * the eVault's auto-certification and the paper carrier's scans. One set per runtime (keyed by the root runtime, so a command
 * view shares it); a test scripts a port by reaching the same set. `FAKE_REVIEWERS=off` empties the human roles the set
 * fills (rule 4: the item then waits for a 35.7 staff holder and the stall clock does not arm).
 */
import type { Runtime } from "../../runtime/app.ts";

export const FAKE_VENDOR = "FAKE" as const;
/** The roles this process's own FAKEs fill (the FAKE reviewers fill funding_approver and underwriting_reviewer). */
export const FAKE_35_6_ROLES: readonly string[] = ["fnma_portal_operator", "settlement_agent", "notary"];
export const FAKE_35_6_DELAY_S_DEFAULT = 20;

export type RonOp = "identity" | "start" | "enote_created" | "sign" | "notarial_act" | "seal";
export interface RonSessionEvent { readonly seq: number; readonly op: RonOp; readonly at: string; readonly detail: Record<string, unknown> }
/** The RON platform's session feed: the worked example's timeline (identity 14:07/14:11, start, eNote created, 1003 14:18, eNote 14:25/14:26, deed of trust 14:31, acknowledgment 14:36, seal 14:41) relative to the scheduled slot; a test may replace the timeline per closing. */
export class FakeRonSessionFeed {
  readonly vendorName = FAKE_VENDOR;
  private readonly timelines = new Map<string, readonly RonSessionEvent[]>();
  private readonly consumed = new Map<string, number>();
  /** Script a session's timeline (default: the worked example's offsets from the slot). */
  script(closingId: string, events: readonly RonSessionEvent[]): void { this.timelines.set(closingId, events); }
  timeline(closingId: string, scheduledAt: string, signers: readonly string[], documents: { enote: string; final_1003: string; security_instrument: string }, opts: { enote: boolean; min: string | null; partner_org_id: string | null; notary_party_id: string }): readonly RonSessionEvent[] {
    const t = this.timelines.get(closingId); if (t) return t;
    const at = (m: number): string => new Date(Date.parse(scheduledAt) + m * 60_000).toISOString();
    const out: RonSessionEvent[] = []; let seq = 0;
    signers.forEach((party, k) => out.push({ seq: ++seq, op: "identity", at: at(7 + 4 * k), detail: { party_id: party, method: "credential_analysis_kba", credential_type: "driver_license", credential_analysis_result: "pass", kba_attempts: [{ questions: 5, correct: k === 0 ? 5 : 4, seconds: 71, at: at(7 + 4 * k), notary_party_id: opts.notary_party_id }], notary_party_id: opts.notary_party_id, vendor: FAKE_VENDOR } }));
    out.push({ seq: ++seq, op: "start", at: at(12), detail: {} });
    if (opts.enote) out.push({ seq: ++seq, op: "enote_created", at: at(13), detail: { closing_document_id: documents.enote, min: opts.min, partner_org_id: opts.partner_org_id } });
    out.push({ seq: ++seq, op: "sign", at: at(18), detail: { closing_document_id: documents.final_1003, kind: "final_1003", signer_party_id: signers[0], signed_at: at(18), signature_method: "esign_ron", required_note_signers: signers } });
    signers.forEach((party, k) => out.push({ seq: ++seq, op: "sign", at: at(25 + k), detail: { closing_document_id: documents.enote, kind: opts.enote ? "enote" : "note", signer_party_id: party, signed_at: at(25 + k), signature_method: "esign_ron", required_note_signers: signers } }));
    signers.forEach((party) => out.push({ seq: ++seq, op: "sign", at: at(31), detail: { closing_document_id: documents.security_instrument, kind: "security_instrument", signer_party_id: party, signed_at: at(31), signature_method: "esign_ron", required_note_signers: signers } }));
    out.push({ seq: ++seq, op: "notarial_act", at: at(36), detail: { closing_document_id: documents.security_instrument, kind: "security_instrument", act_type: "acknowledgment", completed_at: at(36), certificate_indicates_communication_technology: true, recordable: true, last: true, notary_party_id: opts.notary_party_id } });
    out.push({ seq: ++seq, op: "seal", at: at(41), detail: { signing_completed_at: at(25 + signers.length - 1), tamper_sealed_at: at(41) } });
    this.timelines.set(closingId, out);
    return out;
  }
  /** The events at or before `now` the pass has not applied yet (idempotent by session + sequence). */
  pending(closingId: string, events: readonly RonSessionEvent[], nowIso: string): readonly RonSessionEvent[] { const c = this.consumed.get(closingId) ?? 0; return events.filter((e) => e.seq > c && e.at <= nowIso); }
  applied(closingId: string, seq: number): void { this.consumed.set(closingId, Math.max(this.consumed.get(closingId) ?? 0, seq)); }
  consumedThrough(closingId: string): number { return this.consumed.get(closingId) ?? 0; }
}

export interface SettlementStatement { readonly statement_id: string; readonly kind: "requested_net" | "final"; readonly requested_net_cents: bigint; readonly escrow_deposit_cents: bigint; readonly document_id: string; readonly received_at: string }
/** The settlement agent (FAKE): asked for the requested-net statement once the worksheet exists, the receipt confirmation once the wire is accepted, the final settlement statement after the funds arrive. A test scripts a statement per application (the money-mismatch branch). */
export class FakeSettlementAgent {
  readonly vendorName = FAKE_VENDOR;
  private readonly scripted = new Map<string, SettlementStatement[]>();
  script(applicationId: string, s: SettlementStatement): void { const l = this.scripted.get(applicationId) ?? []; l.push(s); this.scripted.set(applicationId, l); }
  scripted_for(applicationId: string, kind: SettlementStatement["kind"]): SettlementStatement | null { return (this.scripted.get(applicationId) ?? []).filter((s) => s.kind === kind).at(-1) ?? null; }
}
export interface OperatorEvidence { readonly fnma_loan_number: string; readonly submitted_at: string; readonly evidence: readonly { kind: string; document_id: string }[] }
/** The Fannie Mae portal operator (FAKE): submits the frozen package after the delay with the four evidence kinds and the captured Loan Delivery state. */
export class FakePortalOperator {
  readonly vendorName = FAKE_VENDOR;
  readonly delaySeconds: number;
  constructor(delaySeconds: number) { this.delaySeconds = delaySeconds; }
  ready(openedAt: string, nowIso: string): boolean { return Date.parse(nowIso) >= Date.parse(openedAt) + this.delaySeconds * 1000; }
  evidence(taskId: string, loanId: string, nowIso: string): OperatorEvidence {
    const n = String(4_000_000_000 + Number(BigInt("0x" + loanId.replace(/-/g, "").slice(0, 8)) % 999_999_999n)).padStart(10, "0");
    return { fnma_loan_number: n, submitted_at: nowIso, evidence: ["import_result_screenshot", "edit_history_csv", "loan_record_print", "wire_details_screenshot"].map((kind, k) => ({ kind, document_id: `FAKE-ev-${taskId.slice(0, 8)}-${k + 1}` })) };
  }
}
/** The eVault (FAKE): auto-certifies an eNote delivery when polled after the submission (C1-2-04 auto-certification the same day). */
export class FakeEvaultCertifier { readonly vendorName = FAKE_VENDOR; certifies(submittedAt: string, nowIso: string): boolean { return Date.parse(nowIso) >= Date.parse(submittedAt); } }
/** The carrier (FAKE): a paper package tendered on day D is scanned received the next business morning and certified by the custodian the morning after; a test may script the two instants per delivery. */
export class FakeCarrier {
  readonly vendorName = FAKE_VENDOR;
  private readonly scripted = new Map<string, { received_at: string; certified_at: string }>();
  script(deliveryId: string, s: { received_at: string; certified_at: string }): void { this.scripted.set(deliveryId, s); }
  scans(deliveryId: string, tenderedAt: string): { received_at: string; certified_at: string } {
    const s = this.scripted.get(deliveryId); if (s) return s;
    const day = 86_400_000; const t = Date.parse(tenderedAt);
    return { received_at: new Date(t + day).toISOString(), certified_at: new Date(t + 2 * day).toISOString() };
  }
}

export interface Fakes35_6 { readonly ron: FakeRonSessionFeed; readonly settlementAgent: FakeSettlementAgent; readonly operator: FakePortalOperator; readonly evault: FakeEvaultCertifier; readonly carrier: FakeCarrier; readonly roles: readonly string[]; readonly delaySeconds: number; fills(role: string): boolean }
const sets = new WeakMap<Runtime, Fakes35_6>();
/** The runtime's FAKE set (rule 4 / operational prerequisite 35.7): the operator, the settlement agent and the notary, after the delay, as `{kind: human, id: FAKE:<role>, role}`; empty under FAKE_REVIEWERS=off or outside INTEGRATIONS=fake. */
export function fakesFor(rt: Runtime): Fakes35_6 {
  const root = rt.root ?? rt;
  const have = sets.get(root); if (have) return have;
  const env = (root as { env?: NodeJS.ProcessEnv }).env ?? process.env;
  const environment = (root as { environment?: string }).environment ?? env["ENVIRONMENT"] ?? "nonprod";
  const off = environment === "production" || environment === "prod" || (env["FAKE_REVIEWERS"] ?? "").trim().toLowerCase() === "off" || (env["INTEGRATIONS"] ?? "fake") !== "fake";
  const delay = Number(env["FAKE_REVIEWER_DELAY_S"] ?? FAKE_35_6_DELAY_S_DEFAULT);
  const roles = off ? [] : FAKE_35_6_ROLES;
  const f: Fakes35_6 = { ron: new FakeRonSessionFeed(), settlementAgent: new FakeSettlementAgent(), operator: new FakePortalOperator(Number.isFinite(delay) ? delay : FAKE_35_6_DELAY_S_DEFAULT), evault: new FakeEvaultCertifier(), carrier: new FakeCarrier(), roles, delaySeconds: Number.isFinite(delay) ? delay : FAKE_35_6_DELAY_S_DEFAULT, fills: (role) => roles.includes(role) };
  sets.set(root, f);
  return f;
}
export const fakeHuman = (role: string): { kind: "human"; id: string; role: string } => ({ kind: "human", id: `FAKE:${role}`, role });
