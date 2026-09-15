/**
 * The `fnma-du` port — Desktop Underwriter over Fannie Mae's Direct Integration channel — as 23.7 rule 9 fixes it, so
 * the FAKE here and a real DI adapter are interchangeable:
 *
 *   submit({document_bytes, sha256, casefile_id, submission_number, seller_number, system_id_ref}) → {du_casefile_id, acked_at}
 *   fetchFindings(du_casefile_id, submission_number) → DuFindings
 *
 * The bytes are the DU Specification document 23.6 emitted (MISMO 3.4 B324 with the DU/ULAD extensions); `sha256` is
 * the hash 23.1 carries as `request_hash` (23.6 rule 6: the hash is the bytes); the credentials are the partner's seller
 * number with SM's TSP identity (23.1 records them on the casefile; 23.7 rule 8 asserts them before transmit).
 * `du_casefile_id` is DU's own `AutomatedUnderwritingCaseIdentifier`, minted by DU on the first submission and carried
 * on every resubmission — never `du_casefiles.casefile_id`, which is ours (23.7 "Casefile identifier round-trip"; 23.5
 * writes it once on `applications.du_casefile_id`).
 *
 * FAKE (every build stage; INTEGRATIONS=fake wires it in src/runtime/origination.ts): `FakeDuPort` validates
 * `document_bytes` against the vendored schema chain with `xmllint` before answering and refuses with
 * `DuTransportError(400)` on failure (23.7-T8) — a FAKE run exercises the same path a real adapter is refused on; it
 * mints a deterministic ten-digit `du_casefile_id` from our casefile id on submission 1 and echoes it after; its
 * findings are the spec's fixture (src/domain/underwriting/ops-23-1.ts `fixtureFindings`, `fakeValidationResults`,
 * `fakeDuMessages` — 32.18 rule 5's validation service over the FAKE Plaid's asset reports), exactly as before the move.
 * `OutageDuPort` is the DI channel returning transport errors (23.1-T13). The real adapter is not built: the DI
 * transport and the DU Error Codes document are login-gated (23.7 Operational prerequisites; UNVERIFIED).
 *
 * Errors: `DuTransportError` carries an HTTP-shaped `status`. 5xx is the channel (23.1 retries with exponential backoff
 * and declares an outage after 30 minutes); 4xx is DU refusing what it was sent (no retry — 23.1's error path, and
 * 23.7's preflight exists so it is never seen for a reason the corpus already knows).
 */
import { createHash } from "node:crypto";
import { xmllintErrorsOf } from "./du-schema/index.ts";
import { dtiBps, DU_MAX_DTI_BPS, fakeValidationResults, fixtureFindings, type DuFindings, type DuMessage, type DuRequest, type FakeAssetReportFacts, type Recommendation, type ValidationResult } from "../../domain/underwriting/ops-23-1.ts";

export class DuTransportError extends Error {
  readonly status: number;
  constructor(message: string, status = 503) { super(message); this.name = "DuTransportError"; this.status = status; }
}

/** 23.7 rule 9: what a submission carries to DU. */
export interface DuSubmitRequest {
  /** The DU Specification document exactly as 23.6 emitted it — the bytes `sha256` hashes. */
  readonly document_bytes: Uint8Array;
  /** SHA-256 (hex) of `document_bytes`; 23.1's `request_hash`. */
  readonly sha256: string;
  /** Ours (`du_casefiles.casefile_id`) — the submission's key on our side; DU answers with its own. */
  readonly casefile_id: string;
  readonly submission_number: number;
  /** The partner's nine-digit Fannie Mae seller number (the submission goes in under the partner). */
  readonly seller_number: string;
  /** The System ID Fannie Mae assigned SM's TSP product. */
  readonly system_id_ref: string;
  /**
   * FAKE seam, not part of the wire contract: 23.1's `DuRequest` the bytes were assembled from. The FAKE's findings
   * are the spec's fixture arithmetic over the request's ULAD snapshot and validation-report references (32.18 rule 5)
   * rather than a reading of the bytes, so the FAKE needs the request to answer as it always has. A real adapter
   * reads the six fields above and nothing else.
   */
  readonly source?: DuRequest;
}
/** DU's acknowledgement of a submission: its own casefile identifier (minted on submission 1, echoed after) and when. */
export interface DuSubmitAck { readonly du_casefile_id: string; readonly acked_at: string; }
export interface DuPort {
  submit(req: DuSubmitRequest): Promise<DuSubmitAck>;
  fetchFindings(du_casefile_id: string, submission_number: number): Promise<DuFindings>;
}

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * The FAKE's `du_casefile_id` for one of our casefiles: ten digits, deterministic — the digits of SHA-256(casefile_id)
 * (hex, so digits only), the first non-zero digit leading, extended by re-hashing in the (practically unreachable) case
 * the digest carries fewer than ten. The same casefile always maps to the same identifier, so a resubmission sees the
 * id its first ack carried, and two casefiles never share one.
 */
export function fakeDuCasefileId(casefile_id: string): string {
  let digits = ""; let seed = casefile_id;
  while (digits.length < 10) {
    const hex = createHash("sha256").update(seed).digest("hex");
    digits += hex.replace(/[^0-9]/g, "");
    seed = hex;
  }
  digits = digits.replace(/^0+/, "");
  while (digits.length < 10) { const hex = createHash("sha256").update(digits).digest("hex"); digits += hex.replace(/[^0-9]/g, ""); }
  return digits.slice(0, 10);
}

export interface FakeDuPortOptions {
  readonly recommend?: (req: DuRequest) => Recommendation;
  readonly findings?: Partial<DuFindings>;
  /** 32.18 rule 5: what the FAKE validation service knows about an asset report reference (the FAKE Plaid registers them). */
  readonly assetReport?: (identifier: string) => FakeAssetReportFacts | undefined;
  readonly messages?: (req: DuRequest, validation: readonly ValidationResult[]) => DuMessage[];
  /** Test seam: the identifier the ack carries for a submission (default: `fakeDuCasefileId(casefile_id)`, the same on every submission of a casefile). 23.7-T9's conflict case answers a different one. */
  readonly mint?: (casefile_id: string, submission_number: number) => string;
}
export interface FakeDuSubmission { readonly req: DuSubmitRequest; readonly submission_number: number; readonly du_casefile_id: string; readonly acked_at: string; readonly xmllint: readonly string[]; }

export class FakeDuPort implements DuPort {
  /** Every submission the FAKE accepted, in order — a refused one (400) is not recorded (23.7-T8). */
  readonly requests: FakeDuSubmission[] = [];
  /** Every submission the FAKE refused, with xmllint's diagnostics — the audit's "on the FAKE — the xmllint result". */
  readonly refused: { readonly req: DuSubmitRequest; readonly status: number; readonly errors: readonly string[]; readonly at: string }[] = [];
  private readonly minted = new Map<string, string>();
  private readonly validated = new Map<string, readonly string[]>();
  private readonly clock: { now(): string };
  private readonly recommend: (req: DuRequest) => Recommendation;
  private readonly extra: Partial<DuFindings>;
  private readonly assetReport: (identifier: string) => FakeAssetReportFacts | undefined;
  private readonly messagesFor: ((req: DuRequest, validation: readonly ValidationResult[]) => DuMessage[]) | null;
  private readonly mint: ((casefile_id: string, submission_number: number) => string) | null;
  constructor(clock: { now(): string }, opts: FakeDuPortOptions = {}) {
    this.clock = clock; this.recommend = opts.recommend ?? ((req) => (dtiBps(req.snapshot.total_obligations_cents, req.snapshot.qualifying_income_cents) > DU_MAX_DTI_BPS ? "approve_ineligible" : "approve_eligible")); this.extra = opts.findings ?? {};
    this.assetReport = opts.assetReport ?? (() => undefined); this.messagesFor = opts.messages ?? null; this.mint = opts.mint ?? null;
  }
  /** xmllint over the bytes, once per distinct hash (the chain is 6.9M of XSD; the same bytes validate the same way). */
  private lint(req: DuSubmitRequest): readonly string[] {
    const key = sha256Hex(req.document_bytes);
    if (key !== req.sha256) return [`sha256 ${req.sha256} is not the hash of the ${req.document_bytes.byteLength} bytes sent (${key})`];
    let errors = this.validated.get(key);
    if (!errors) { errors = xmllintErrorsOf(req.document_bytes); this.validated.set(key, errors); }
    return errors;
  }
  async submit(req: DuSubmitRequest): Promise<DuSubmitAck> {
    const at = this.clock.now();
    for (const k of ["casefile_id", "seller_number", "system_id_ref"] as const) if (typeof req[k] !== "string" || !req[k].trim()) { this.refused.push({ req, status: 400, errors: [`${k} missing`], at }); throw new DuTransportError(`DU refused submission ${req.submission_number}: ${k} missing`, 400); }
    if (!Number.isInteger(req.submission_number) || req.submission_number < 1) { this.refused.push({ req, status: 400, errors: ["submission_number"], at }); throw new DuTransportError(`DU refused the submission: submission_number ${String(req.submission_number)}`, 400); }
    const errors = this.lint(req);
    if (errors.length) {
      this.refused.push({ req, status: 400, errors, at });
      throw new DuTransportError(`DU refused submission ${req.submission_number} on casefile ${req.casefile_id}: the document does not validate against the DU schema chain — ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ""}`, 400);
    }
    const du_casefile_id = this.mint ? this.mint(req.casefile_id, req.submission_number) : (this.minted.get(req.casefile_id) ?? fakeDuCasefileId(req.casefile_id));
    this.minted.set(req.casefile_id, du_casefile_id);
    this.requests.push({ req, submission_number: req.submission_number, du_casefile_id, acked_at: at, xmllint: errors });
    return { du_casefile_id, acked_at: at };
  }
  async fetchFindings(du_casefile_id: string, submission_number: number): Promise<DuFindings> {
    const r = this.requests.find((x) => x.du_casefile_id === du_casefile_id && x.submission_number === submission_number);
    if (!r) throw new DuTransportError(`no submission ${submission_number} on DU casefile ${du_casefile_id}`, 404);
    const source = r.req.source;
    if (!source) throw new RangeError(`FakeDuPort: submission ${submission_number} on DU casefile ${du_casefile_id} carried no \`source\` DuRequest — the FAKE's findings are the fixture over the request's snapshot (23.1 submitCasefile passes it)`);
    const now = this.clock.now();
    // 32.18 rule 5: the validation service's results from the request's asset report references (a test's explicit `findings.validation_results` still wins)
    const validation = this.extra.validation_results ?? fakeValidationResults(source, this.assetReport, now);
    const messages = this.extra.messages ?? (this.messagesFor ? this.messagesFor(source, validation) : undefined);
    return fixtureFindings(source, submission_number, now, this.recommend(source), { ...this.extra, validation_results: validation, ...(messages ? { messages } : {}) });
  }
}

/** A DI channel returning transport errors (23.1-T13). */
export class OutageDuPort implements DuPort {
  attempts = 0;
  async submit(): Promise<DuSubmitAck> { this.attempts++; throw new DuTransportError("DI channel: connection reset", 503); }
  async fetchFindings(): Promise<DuFindings> { throw new DuTransportError("DI channel: connection reset", 503); }
}
