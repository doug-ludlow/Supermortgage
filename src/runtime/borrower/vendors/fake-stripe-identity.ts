/**
 * FakeStripeIdentity — the L3 identity vendor (docs/ux/01-foundations.md §5: Stripe Identity, government ID + selfie)
 * as an in-memory test double. FAKE: nothing leaves the process; a session "completes" on a deterministic call
 * (`complete(vendorSessionId)` or the webhook body `identity.verification_session.verified`), and the extracted
 * name / DOB / address are derived from what the application already holds (the fixture's legal name, the DOB on file
 * or a fixed one, the subject property address) so the ConfirmCard has something to confirm. Every call logs
 * `vendor: "FAKE"`. Swap: implement `StripeIdentityPort` over the Stripe Identity API (VerificationSessions.create,
 * webhook signature verification with STRIPE_WEBHOOK_SECRET) in DEPLOY.md "Borrower API".
 */
import { randomUUID } from "node:crypto";
import type { IdentitySessionResult } from "../../../domain/verification/ops-22-6.ts";
import type { PlainDate } from "../../../kernel/calendar/date.ts";

export interface IdentitySessionRequest { readonly party_id: string; readonly application_id: string; readonly application_borrower_id: string; readonly legal_name: string; readonly date_of_birth: string | null; readonly address: string | null; readonly return_url: string; }
export interface VendorIdentitySession { readonly vendor: string; readonly vendor_session_id: string; readonly client_secret: string; readonly status: "requires_input" | "processing" | "verified" | "canceled"; readonly return_url: string; }
export interface IdentityExtraction { readonly legal_name: string; readonly date_of_birth: string; readonly address: string; readonly id_document_type: IdentitySessionResult["id_document_type"]; readonly id_document_issuer: string; readonly id_document_expires_on: PlainDate; }
export interface IdentityWebhookEvent { readonly id: string; readonly type: string; readonly data: { readonly object: { readonly id: string; readonly status?: string; readonly [k: string]: unknown } }; }
export interface StripeIdentityPort {
  readonly vendorName: string;
  createSession(req: IdentitySessionRequest, now: string): Promise<VendorIdentitySession>;
  /** Parse and authenticate a webhook delivery; returns the vendor session it concerns and the outcome. */
  parseWebhook(rawBody: string, signatureHeader: string | undefined, now: string): Promise<{ event: IdentityWebhookEvent; vendor_session_id: string; outcome: "verified" | "requires_input" | "canceled" | "ignored" }>;
  /** The vendor's session record: what it extracted and the 22.6 session result the platform records through `verifyIdentity`. */
  result(vendorSessionId: string): Promise<{ request: IdentitySessionRequest; extraction: IdentityExtraction; session_result: IdentitySessionResult } | undefined>;
}

const DEFAULT_DOB: PlainDate = "1988-04-12" as PlainDate;
export class FakeStripeIdentity implements StripeIdentityPort {
  readonly vendorName = "stripe_identity";
  readonly marker = "FAKE" as const;
  readonly sessions = new Map<string, { request: IdentitySessionRequest; session: VendorIdentitySession; extraction: IdentityExtraction | null; completed_at: string | null }>();
  readonly log: { at: string; vendor: "FAKE"; op: string; vendor_session_id: string }[] = [];
  private readonly logger: (line: Record<string, unknown>) => void;
  constructor(logger: (line: Record<string, unknown>) => void = () => undefined) { this.logger = logger; }
  private note(op: string, id: string, at: string): void { const line = { at, vendor: this.marker, op, vendor_session_id: id }; this.log.push(line); this.logger({ msg: "stripe_identity", ...line }); }

  async createSession(req: IdentitySessionRequest, now: string): Promise<VendorIdentitySession> {
    const id = `vs_FAKE_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const session: VendorIdentitySession = { vendor: this.vendorName, vendor_session_id: id, client_secret: `${id}_secret_FAKE`, status: "requires_input", return_url: req.return_url };
    this.sessions.set(id, { request: req, session, extraction: null, completed_at: null });
    this.note("create_session", id, now);
    return session;
  }
  /** Deterministic completion: the document "read" is the application's own facts. */
  complete(vendorSessionId: string, now: string, overrides: Partial<IdentityExtraction> = {}): IdentityExtraction {
    const s = this.sessions.get(vendorSessionId); if (!s) throw new RangeError(`no identity session ${vendorSessionId}`);
    const extraction: IdentityExtraction = { legal_name: s.request.legal_name, date_of_birth: s.request.date_of_birth ?? DEFAULT_DOB, address: s.request.address ?? "1 Fixture Way, Phoenix, AZ 85001", id_document_type: "drivers_license", id_document_issuer: "AZ", id_document_expires_on: "2031-04-12" as PlainDate, ...overrides };
    s.extraction = extraction; s.completed_at = now; (s.session as { status: string }).status = "verified";
    this.note("complete", vendorSessionId, now);
    return extraction;
  }
  async parseWebhook(rawBody: string, signatureHeader: string | undefined, now: string): Promise<{ event: IdentityWebhookEvent; vendor_session_id: string; outcome: "verified" | "requires_input" | "canceled" | "ignored" }> {
    // FAKE signature check: the header must be present and equal "FAKE" (a real adapter verifies the Stripe-Signature HMAC against STRIPE_WEBHOOK_SECRET)
    if (signatureHeader !== "FAKE") throw new RangeError("stripe-signature header must be FAKE for the fake adapter");
    const event = JSON.parse(rawBody) as Partial<IdentityWebhookEvent>;
    const id = event.data?.object?.id;
    if (typeof event.type !== "string" || typeof id !== "string") throw new RangeError("webhook body must be a Stripe event with data.object.id");
    if (!this.sessions.has(id)) throw new RangeError(`no identity session ${id}`);
    this.note(`webhook:${event.type}`, id, now);
    const outcome = event.type === "identity.verification_session.verified" ? "verified" : event.type === "identity.verification_session.requires_input" ? "requires_input" : event.type === "identity.verification_session.canceled" ? "canceled" : "ignored";
    if (outcome === "verified" && !this.sessions.get(id)!.extraction) this.complete(id, now);
    return { event: { id: event.id ?? `evt_FAKE_${randomUUID().slice(0, 8)}`, type: event.type, data: { object: { ...event.data!.object, id } } }, vendor_session_id: id, outcome };
  }
  async result(vendorSessionId: string): Promise<{ request: IdentitySessionRequest; extraction: IdentityExtraction; session_result: IdentitySessionResult } | undefined> {
    const s = this.sessions.get(vendorSessionId);
    if (!s || !s.extraction) return undefined;
    const x = s.extraction;
    const session_result: IdentitySessionResult = { session_id: vendorSessionId, vendor: this.vendorName, document_authentication_result: "pass", liveness_result: "pass", face_match_score: 0.97, face_match_threshold: 0.9,
      id_document_type: x.id_document_type, id_document_issuer: x.id_document_issuer, id_document_expires_on: x.id_document_expires_on, data_match: { name: x.legal_name === s.request.legal_name, date_of_birth: s.request.date_of_birth === null || x.date_of_birth === s.request.date_of_birth, address: true } };
    return { request: s.request, extraction: x, session_result };
  }
}
