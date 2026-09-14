/**
 * FakePlaid — the assets connector (docs/ux/03 P7 / 32.18 rule 1: `ConnectCard{vendor=plaid_assets}`; 22.4 orderAssetReport
 * supplier `plaid`, a 365-day DU validation service asset verification report) as an in-memory test double. FAKE: nothing
 * leaves the process; a session "completes" on `complete()` (the tap with `fake_complete`, 32.17 rule 19) or on the webhook
 * `asset_report.ready`, and the report it returns is deterministic — two accounts and twelve months of payroll deposits from the
 * fixture employer (32.18 rule 5: what the FAKE DU validates employment and income against) — unless the webhook overrides it.
 * Every call logs `vendor: "FAKE"`. Swap: implement `AssetsConnectPort` over Plaid Link + the Assets API (`/asset_report/create`
 * with days_requested 365, the `PRODUCT_READY` webhook, the report token as the DU validation service identifier) in DEPLOY.md.
 *
 * The registry (`FAKE_ASSET_REPORTS`) is what the FAKE DU port reads to compute `validation_results` from a request's
 * `validation_report_refs` (src/runtime/origination.ts wires `lookupFakeAssetReport` into `FakeDuPort`); a real DU does its own
 * matching at Fannie Mae and never sees this map.
 */
import { randomUUID } from "node:crypto";

export interface AssetsSessionRequest { readonly party_id: string; readonly application_id: string; readonly application_borrower_id: string; readonly borrower_id: string; readonly card_instance_id: string; readonly authorization_consent_id: string; }
export interface VendorAssetsSession { readonly vendor: string; readonly vendor_session_id: string; readonly link_token: string; readonly status: "requires_input" | "processing" | "report_ready" | "failed"; }
export interface FakeAssetAccount { readonly institution: string; readonly account_type: "checking" | "savings" | "money_market" | "brokerage"; readonly last4: string; readonly balance_cents: string; }
/** What the FAKE asset report carries: the accounts (22.4's rows), the payroll deposit stream (what DU validates employment and income against), the report's identity. */
export interface FakeAssetReport {
  readonly report_reference_id: string; readonly report_days: 365; readonly vendor_data_as_of: string; readonly report_document_id: string;
  readonly accounts: readonly FakeAssetAccount[];
  readonly payroll_deposits: { readonly employer: string; readonly monthly_cents: string; readonly months: number };
}
export interface AssetsWebhookEvent { readonly type: string; readonly data: { readonly vendor_session_id: string; readonly report?: Partial<FakeAssetReport>; readonly [k: string]: unknown } }
export interface AssetsConnectPort {
  readonly vendorName: string;
  createSession(req: AssetsSessionRequest, now: string): Promise<VendorAssetsSession>;
  parseWebhook(rawBody: string, signatureHeader: string | undefined, now: string): Promise<{ event: AssetsWebhookEvent; vendor_session_id: string; outcome: "report_ready" | "failed" | "ignored"; report: FakeAssetReport | null }>;
  result(vendorSessionId: string): Promise<{ request: AssetsSessionRequest; report: FakeAssetReport | null } | undefined>;
}

/** The FAKE asset reports by report reference — read by the FAKE DU port (32.18 rule 5). Process-wide: one runtime, one FAKE. */
export const FAKE_ASSET_REPORTS = new Map<string, FakeAssetReport>();
export const lookupFakeAssetReport = (reportReferenceId: string): FakeAssetReport | undefined => FAKE_ASSET_REPORTS.get(reportReferenceId);

/** The fixture accounts (32.18 integrations): checking ····4821 $18,400.00, savings ····7730 $42,250.00. */
export const FAKE_ASSET_ACCOUNTS: readonly FakeAssetAccount[] = [
  { institution: "First Desert Bank (FAKE)", account_type: "checking", last4: "4821", balance_cents: "1840000" },
  { institution: "First Desert Bank (FAKE)", account_type: "savings", last4: "7730", balance_cents: "4225000" },
];
/** The fixture payroll stream: $8,200.00 a month for twelve months from the FAKE Truv employer (32.3 T11's figure — the two FAKEs agree). */
export const FAKE_PAYROLL_DEPOSITS = { employer: "Acme Manufacturing (FAKE payroll)", monthly_cents: "820000", months: 12 } as const;

export class FakePlaid implements AssetsConnectPort {
  readonly vendorName = "plaid_assets";
  readonly marker = "FAKE" as const;
  readonly sessions = new Map<string, { request: AssetsSessionRequest; session: VendorAssetsSession; report: FakeAssetReport | null }>();
  readonly log: { at: string; vendor: "FAKE"; op: string; vendor_session_id: string }[] = [];
  private readonly logger: (line: Record<string, unknown>) => void;
  constructor(logger: (line: Record<string, unknown>) => void = () => undefined) { this.logger = logger; }
  private note(op: string, id: string, at: string): void { const line = { at, vendor: this.marker, op, vendor_session_id: id }; this.log.push(line); this.logger({ msg: "plaid_assets", ...line }); }

  async createSession(req: AssetsSessionRequest, now: string): Promise<VendorAssetsSession> {
    const id = `pl_FAKE_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const session: VendorAssetsSession = { vendor: this.vendorName, vendor_session_id: id, link_token: `link-FAKE-${id}`, status: "requires_input" };
    this.sessions.set(id, { request: req, session, report: null });
    this.note("create_session", id, now);
    return session;
  }
  /** The deterministic 365-day report, registered for the FAKE DU; the webhook may override any part (a different deposit stream makes DU's income validation fail — 32.18 T5). */
  complete(vendorSessionId: string, now: string, overrides: Partial<FakeAssetReport> = {}): FakeAssetReport {
    const s = this.sessions.get(vendorSessionId); if (!s) throw new RangeError(`no assets session ${vendorSessionId}`);
    const report: FakeAssetReport = { report_reference_id: `PLAID-FAKE-${vendorSessionId.slice(-12)}`, report_days: 365, vendor_data_as_of: now.slice(0, 10), report_document_id: `DOC-ASSETS-${vendorSessionId.slice(-12)}`, accounts: FAKE_ASSET_ACCOUNTS, payroll_deposits: { ...FAKE_PAYROLL_DEPOSITS }, ...overrides };
    s.report = report; (s.session as { status: string }).status = "report_ready";
    FAKE_ASSET_REPORTS.set(report.report_reference_id, report);
    this.note("complete", vendorSessionId, now);
    return report;
  }
  async parseWebhook(rawBody: string, signatureHeader: string | undefined, now: string): Promise<{ event: AssetsWebhookEvent; vendor_session_id: string; outcome: "report_ready" | "failed" | "ignored"; report: FakeAssetReport | null }> {
    if (signatureHeader !== "FAKE") throw new RangeError("plaid-verification header must be FAKE for the fake adapter");
    const event = JSON.parse(rawBody) as Partial<AssetsWebhookEvent>;
    const id = event.data?.vendor_session_id;
    if (typeof event.type !== "string" || typeof id !== "string") throw new RangeError("webhook body must be a Plaid event with data.vendor_session_id");
    if (!this.sessions.has(id)) throw new RangeError(`no assets session ${id}`);
    this.note(`webhook:${event.type}`, id, now);
    if (event.type === "asset_report.ready") return { event: event as AssetsWebhookEvent, vendor_session_id: id, outcome: "report_ready", report: this.complete(id, now, event.data?.report ?? {}) };
    if (event.type === "asset_report.failed") { (this.sessions.get(id)!.session as { status: string }).status = "failed"; return { event: event as AssetsWebhookEvent, vendor_session_id: id, outcome: "failed", report: null }; }
    return { event: event as AssetsWebhookEvent, vendor_session_id: id, outcome: "ignored", report: null };
  }
  async result(vendorSessionId: string): Promise<{ request: AssetsSessionRequest; report: FakeAssetReport | null } | undefined> {
    const s = this.sessions.get(vendorSessionId); return s ? { request: s.request, report: s.report } : undefined;
  }
}
