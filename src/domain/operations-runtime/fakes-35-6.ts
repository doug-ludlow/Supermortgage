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
    signers.forEach((party) => out.push({ seq: ++seq, op: "sign", at: at(18), detail: { closing_document_id: documents.final_1003, kind: "final_1003", signer_party_id: party, signed_at: at(18), signature_method: "esign_ron", required_note_signers: signers } }));   // each applicant signs the final 1003 (14:18)
    signers.forEach((party, k) => out.push({ seq: ++seq, op: "sign", at: at(25 + k), detail: { closing_document_id: documents.enote, kind: opts.enote ? "enote" : "note", signer_party_id: party, signed_at: at(25 + k), signature_method: "esign_ron", required_note_signers: signers } }));
    signers.forEach((party) => out.push({ seq: ++seq, op: "sign", at: at(31), detail: { closing_document_id: documents.security_instrument, kind: "security_instrument", signer_party_id: party, signed_at: at(31), signature_method: "esign_ron", required_note_signers: signers } }));
    out.push({ seq: ++seq, op: "notarial_act", at: at(36), detail: { closing_document_id: documents.security_instrument, kind: "security_instrument", act_type: "acknowledgment", completed_at: at(36), certificate_indicates_communication_technology: true, recordable: true, last: true, notary_party_id: opts.notary_party_id } });
    out.push({ seq: ++seq, op: "seal", at: at(41), detail: { signing_completed_at: at(25 + signers.length - 1), tamper_sealed_at: at(41) } });
    this.timelines.set(closingId, out);
    return out;
  }
  /** The platform's sealed Authoritative Copy (the SMART Doc bytes 26.2 validates against the seal) and its audit trail (the recording reference and the trail's hash 26.2 ingests). */
  authoritativeCopy(min: string | null, amount: string, rate: string): string { return `<SMART_DOCUMENT version="1.02"><DATA min="${min ?? ""}" amount="${amount}" rate="${rate}"/></SMART_DOCUMENT>`; }
  auditTrail(closingId: string, sessionRef: string | null, events: readonly RonSessionEvent[]): { text: string; recording_ref: string; journal_ref: string } {
    const text = JSON.stringify({ closing_id: closingId, session_ref: sessionRef, vendor: FAKE_VENDOR, events: events.map((e) => ({ seq: e.seq, op: e.op, at: e.at })) });
    return { text, recording_ref: `${FAKE_VENDOR}-REC-${closingId.slice(0, 24)}`, journal_ref: `${FAKE_VENDOR}-JOURNAL-${closingId.slice(0, 24)}` };
  }
  /** The events at or before `now` the pass has not applied yet (idempotent by session + sequence). */
  pending(closingId: string, events: readonly RonSessionEvent[], nowIso: string): readonly RonSessionEvent[] { const c = this.consumed.get(closingId) ?? 0; return events.filter((e) => e.seq > c && e.at <= nowIso); }
  applied(closingId: string, seq: number): void { this.consumed.set(closingId, Math.max(this.consumed.get(closingId) ?? 0, seq)); }
  consumedThrough(closingId: string): number { return this.consumed.get(closingId) ?? 0; }
}

export interface SettlementStatement { readonly statement_id: string; readonly kind: "requested_net" | "final"; readonly requested_net_cents: bigint; readonly escrow_deposit_cents: bigint; readonly received_at: string }
export interface SettlementFeeQuote { readonly fees: readonly { fee_code: string; amount_cents: string }[]; readonly quoted_at: string; readonly title_order_id: string }
/** The settlement agent (FAKE): the title-order fee quote 25.2 records as the settlement_agent figure source; the requested-net statement once the worksheet exists (the CD's net unless a test scripts a different figure — the money-mismatch branch); the funds-received confirmation once the wire is accepted; the final settlement statement after the funds arrive (delayed or withheld by a test — T13). */
export class FakeSettlementAgent {
  readonly vendorName = FAKE_VENDOR;
  private readonly scripted = new Map<string, SettlementStatement[]>();
  private readonly withheld = new Map<string, string | null>();
  script(applicationId: string, s: SettlementStatement): void { const l = this.scripted.get(applicationId) ?? []; l.push(s); this.scripted.set(applicationId, l); }
  /** Withhold the final statement until `untilIso` (null: indefinitely) — the stalled step of T13. */
  withholdFinal(applicationId: string, untilIso: string | null): void { this.withheld.set(applicationId, untilIso); }
  scripted_for(applicationId: string, kind: SettlementStatement["kind"]): SettlementStatement | null { return (this.scripted.get(applicationId) ?? []).filter((s) => s.kind === kind).at(-1) ?? null; }
  /** The agent's fee quote against the title order: the worked example's lender's policy, settlement fee and recording (25.2's SRC-SA lines). */
  feeQuote(titleOrderId: string, quotedAt: string): SettlementFeeQuote { return { title_order_id: titleOrderId, quoted_at: quotedAt, fees: [{ fee_code: "title_lender_policy", amount_cents: "120000" }, { fee_code: "settlement_fee", amount_cents: "60000" }, { fee_code: "recording", amount_cents: "3000" }] }; }
  /** The statement requesting the net: the scripted one, else the agent's own figures = the CD's (the worksheet's net and escrow deposit). */
  requestedNet(applicationId: string, cd: { net_wire_cents: bigint; escrow_deposit_cents: bigint }, nowIso: string): SettlementStatement {
    return this.scripted_for(applicationId, "requested_net") ?? { statement_id: `${FAKE_VENDOR}-SS-${applicationId.slice(0, 8)}-1`, kind: "requested_net", requested_net_cents: cd.net_wire_cents, escrow_deposit_cents: cd.escrow_deposit_cents, received_at: nowIso };
  }
  /** The funds-received confirmation: the agent confirms through the portal once the bank accepted the wire. */
  receiptConfirmation(acceptedAtIso: string): { funds_received_by_agent_at: string; channel: "portal" } { return { funds_received_by_agent_at: acceptedAtIso, channel: "portal" }; }
  /** The final settlement statement after disbursement (null while withheld). */
  finalStatement(applicationId: string, cd: { net_wire_cents: bigint; escrow_deposit_cents: bigint }, disbursedAtIso: string, nowIso: string): SettlementStatement | null {
    if (this.withheld.has(applicationId)) { const until = this.withheld.get(applicationId); if (until === null || until === undefined || nowIso < until) return null; }
    return this.scripted_for(applicationId, "final") ?? { statement_id: `${FAKE_VENDOR}-FSS-${applicationId.slice(0, 8)}`, kind: "final", requested_net_cents: cd.net_wire_cents, escrow_deposit_cents: cd.escrow_deposit_cents, received_at: disbursedAtIso };
  }
}
/** The funding bank (FAKE, 26.3's wire channel): a released wire is accepted with an IMAD on the next poll; a test may reject one. */
export class FakeFundingBank {
  readonly vendorName = FAKE_VENDOR;
  private readonly rejected = new Map<string, string>();
  reject(wireId: string, reason: string): void { this.rejected.set(wireId, reason); }
  poll(wireId: string, releasedAtIso: string, nowIso: string): { status: "accepted"; imad: string; accepted_at: string } | { status: "rejected"; reason: string } | { status: "pending" } {
    if (this.rejected.has(wireId)) return { status: "rejected", reason: this.rejected.get(wireId)! };
    if (nowIso < releasedAtIso) return { status: "pending" };
    const d = releasedAtIso.slice(0, 10).replace(/-/g, "");
    return { status: "accepted", imad: `${d}B1QGC01R${wireId.replace(/[^0-9A-Za-z]/g, "").slice(-6).toUpperCase().padStart(6, "0")}`, accepted_at: new Date(Date.parse(releasedAtIso) + 60_000).toISOString() };
  }
}
/** The print/mail vendor (FAKE): a CD printed and tendered to USPS the same day → the mailing proof (the USPS acceptance) 25.2's mailbox rule keys on. */
export class FakePrintMail {
  readonly vendorName = FAKE_VENDOR;
  mail(disclosureId: string, consumerId: string, atIso: string): { mailing_proof_id: string; mailed_at: string } { return { mailing_proof_id: `${FAKE_VENDOR}-USPS-${disclosureId.slice(0, 16)}-${consumerId}`, mailed_at: atIso }; }
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
/** The UCD collection (FAKE): Fannie Mae's Uniform Closing Dataset collection accepts a generated submission over DI — the casefile id keyed to the DU casefile, no critical edits (25.2 ask: a `fnma-ucd` port on the runtime). */
export class FakeUcdCollection { readonly vendorName = FAKE_VENDOR; respond(ucdSubmissionId: string, duCasefileId: string): { status: "accepted"; casefile_id_ucd: string; critical_edit_failures: number; feedback_messages: string[] } { void ucdSubmissionId; return { status: "accepted", casefile_id_ucd: duCasefileId, critical_edit_failures: 0, feedback_messages: [] }; } }
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

export interface Fakes35_6 { readonly ron: FakeRonSessionFeed; readonly settlementAgent: FakeSettlementAgent; readonly bank: FakeFundingBank; readonly printMail: FakePrintMail; readonly operator: FakePortalOperator; readonly evault: FakeEvaultCertifier; readonly ucd: FakeUcdCollection; readonly carrier: FakeCarrier; readonly roles: readonly string[]; readonly delaySeconds: number; fills(role: string): boolean }
const sets = new WeakMap<Runtime, Fakes35_6>();
/** The build stage as the runtime states it (`root.environment`) or ENVIRONMENT names it; `nonprod` when neither does. Read fresh on every call (rule 6's production refusal is decided per hand-off). */
export function environmentOf(rt: Runtime): string {
  const root = rt.root ?? rt; const env = (root as { env?: NodeJS.ProcessEnv }).env ?? process.env;
  return (root as { environment?: string }).environment ?? env["ENVIRONMENT"] ?? "nonprod";
}
/** The runtime's FAKE set (rule 4 / operational prerequisite 35.7): the operator, the settlement agent and the notary, after the delay, as `{kind: human, id: FAKE:<role>, role}`; empty under FAKE_REVIEWERS=off or outside INTEGRATIONS=fake. */
export function fakesFor(rt: Runtime): Fakes35_6 {
  const root = rt.root ?? rt;
  const have = sets.get(root); if (have) return have;
  const env = (root as { env?: NodeJS.ProcessEnv }).env ?? process.env;
  const environment = (root as { environment?: string }).environment ?? env["ENVIRONMENT"] ?? "nonprod";
  const off = environment === "production" || environment === "prod" || (env["FAKE_REVIEWERS"] ?? "").trim().toLowerCase() === "off" || (env["INTEGRATIONS"] ?? "fake") !== "fake";
  const delay = Number(env["FAKE_REVIEWER_DELAY_S"] ?? FAKE_35_6_DELAY_S_DEFAULT);
  const roles = off ? [] : FAKE_35_6_ROLES;
  const f: Fakes35_6 = { ron: new FakeRonSessionFeed(), settlementAgent: new FakeSettlementAgent(), bank: new FakeFundingBank(), printMail: new FakePrintMail(), operator: new FakePortalOperator(Number.isFinite(delay) ? delay : FAKE_35_6_DELAY_S_DEFAULT), evault: new FakeEvaultCertifier(), ucd: new FakeUcdCollection(), carrier: new FakeCarrier(), roles, delaySeconds: Number.isFinite(delay) ? delay : FAKE_35_6_DELAY_S_DEFAULT, fills: (role) => roles.includes(role) };
  sets.set(root, f);
  return f;
}
export const fakeHuman = (role: string): { kind: "human"; id: string; role: string } => ({ kind: "human", id: `FAKE:${role}`, role });
