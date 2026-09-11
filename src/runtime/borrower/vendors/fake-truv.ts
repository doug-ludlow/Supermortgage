/**
 * FakeTruv — the payroll / income connector (docs/ux/03 R3: `ConnectCard{vendor=truv_income}`; 22.3 orderVerificationReport
 * supplier TRUV) as an in-memory test double. FAKE: nothing leaves the process; a session "completes" on the webhook
 * `voie.report.ready`, and the report it returns is deterministic (employer, pay frequency, monthly base and variable pay,
 * year-to-date) unless the webhook body overrides it. Every call logs `vendor: "FAKE"`. Swap: implement `IncomeConnectPort`
 * over the Truv API (Link tokens, `verification.report` webhooks with the Truv-Signature HMAC) in DEPLOY.md "Borrower API".
 */
import { randomUUID } from "node:crypto";

export interface IncomeSessionRequest { readonly party_id: string; readonly application_id: string; readonly application_borrower_id: string; readonly borrower_id: string; readonly card_instance_id: string; readonly order_id: string | null; }
export interface VendorIncomeSession { readonly vendor: string; readonly vendor_session_id: string; readonly link_token: string; readonly status: "requires_input" | "processing" | "report_ready" | "failed"; }
/** What the FAKE payroll report carries — the ConfirmCard's prefilled fields (R3); money as bigint cents in strings. */
export interface FakeIncomeReport { readonly employer: string; readonly position: string; readonly start_date: string; readonly pay_frequency: string; readonly monthly_base_cents: string; readonly monthly_variable_cents: string; readonly ytd_cents: string; readonly vendor_data_as_of: string; readonly report_reference_id: string; readonly report_document_id: string; }
export interface IncomeWebhookEvent { readonly type: string; readonly data: { readonly vendor_session_id: string; readonly report?: Partial<FakeIncomeReport>; readonly [k: string]: unknown } }
export interface IncomeConnectPort {
  readonly vendorName: string;
  createSession(req: IncomeSessionRequest, now: string): Promise<VendorIncomeSession>;
  parseWebhook(rawBody: string, signatureHeader: string | undefined, now: string): Promise<{ event: IncomeWebhookEvent; vendor_session_id: string; outcome: "report_ready" | "failed" | "ignored"; report: FakeIncomeReport | null }>;
  result(vendorSessionId: string): Promise<{ request: IncomeSessionRequest; report: FakeIncomeReport | null } | undefined>;
}

export class FakeTruv implements IncomeConnectPort {
  readonly vendorName = "truv_income";
  readonly marker = "FAKE" as const;
  readonly sessions = new Map<string, { request: IncomeSessionRequest; session: VendorIncomeSession; report: FakeIncomeReport | null }>();
  readonly log: { at: string; vendor: "FAKE"; op: string; vendor_session_id: string }[] = [];
  private readonly logger: (line: Record<string, unknown>) => void;
  constructor(logger: (line: Record<string, unknown>) => void = () => undefined) { this.logger = logger; }
  private note(op: string, id: string, at: string): void { const line = { at, vendor: this.marker, op, vendor_session_id: id }; this.log.push(line); this.logger({ msg: "truv_income", ...line }); }

  async createSession(req: IncomeSessionRequest, now: string): Promise<VendorIncomeSession> {
    const id = `tv_FAKE_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const session: VendorIncomeSession = { vendor: this.vendorName, vendor_session_id: id, link_token: `${id}_link_FAKE`, status: "requires_input" };
    this.sessions.set(id, { request: req, session, report: null });
    this.note("create_session", id, now);
    return session;
  }
  /** The deterministic report: the fixture employer, biweekly pay, $8,200 monthly base (03 T11) unless the webhook overrides it. */
  complete(vendorSessionId: string, now: string, overrides: Partial<FakeIncomeReport> = {}): FakeIncomeReport {
    const s = this.sessions.get(vendorSessionId); if (!s) throw new RangeError(`no income session ${vendorSessionId}`);
    const report: FakeIncomeReport = { employer: "Acme Manufacturing (FAKE payroll)", position: "Operations analyst", start_date: "2021-03-15", pay_frequency: "biweekly", monthly_base_cents: "820000", monthly_variable_cents: "0", ytd_cents: "7790000", vendor_data_as_of: now.slice(0, 10), report_reference_id: `TRUV-FAKE-${vendorSessionId.slice(-8)}`, report_document_id: `doc-truv-FAKE-${vendorSessionId.slice(-8)}`, ...overrides };
    s.report = report; (s.session as { status: string }).status = "report_ready";
    this.note("complete", vendorSessionId, now);
    return report;
  }
  async parseWebhook(rawBody: string, signatureHeader: string | undefined, now: string): Promise<{ event: IncomeWebhookEvent; vendor_session_id: string; outcome: "report_ready" | "failed" | "ignored"; report: FakeIncomeReport | null }> {
    // FAKE signature check: the header must be present and equal "FAKE" (a real adapter verifies the Truv-Signature HMAC against the webhook secret)
    if (signatureHeader !== "FAKE") throw new RangeError("x-truv-signature header must be FAKE for the fake adapter");
    const event = JSON.parse(rawBody) as Partial<IncomeWebhookEvent>;
    const id = event.data?.vendor_session_id;
    if (typeof event.type !== "string" || typeof id !== "string") throw new RangeError("webhook body must be a Truv event with data.vendor_session_id");
    if (!this.sessions.has(id)) throw new RangeError(`no income session ${id}`);
    this.note(`webhook:${event.type}`, id, now);
    if (event.type === "voie.report.ready") return { event: event as IncomeWebhookEvent, vendor_session_id: id, outcome: "report_ready", report: this.complete(id, now, event.data?.report ?? {}) };
    if (event.type === "voie.report.failed") { (this.sessions.get(id)!.session as { status: string }).status = "failed"; return { event: event as IncomeWebhookEvent, vendor_session_id: id, outcome: "failed", report: null }; }
    return { event: event as IncomeWebhookEvent, vendor_session_id: id, outcome: "ignored", report: null };
  }
  async result(vendorSessionId: string): Promise<{ request: IncomeSessionRequest; report: FakeIncomeReport | null } | undefined> {
    const s = this.sessions.get(vendorSessionId); return s ? { request: s.request, report: s.report } : undefined;
  }
}
