/**
 * The PURCHASE journey as a reusable fixture — the sibling of ./journey.ts (the refinance). The spec's purchase fixture, driven
 * through the REAL bus tools over the hosted runtime's HTTP surface, phase by phase, on a FixedClock whose reading never runs
 * backwards (the application's append-only log is monotone in `occurred_at`, which purchase-lifecycle.test.ts asserts):
 * Columbus, OH (Franklin County); an organic "still looking" lead (20.3 worked example 2: Thu Oct 15, 2026) with the price range
 * and the down payment as lead facts; the application opened Mon Oct 19 with the property to be determined (21.1 worked example 2:
 * web channel, two applicants, joint intent 18:52 / 20:31 EDT); the signed contract at 1187 Oakwood Ave arriving through 22.1
 * (ingest → classify → FAKE extraction) and 32.2's `application.confirmField{purchase_contract}` — the address and the $457,800
 * price as the fifth item, the $412,000 loan amount at 20:44 EDT as the sixth (`application.trid_received`; LE due Thu Oct 22);
 * 22.6 identity / OFAC and 22.2's tri-merge Tue Oct 20 (representative score 705); 20.4 worked example B on the Tue Oct 20 sheet
 * (HomeReady waiver → 6.375 %, P&I $2,570.34, lender credit $515.00); 22.4 the assets Tue Oct 20 (checking $31,240.18 less the
 * $5,000.00 EMD offset, savings $14,900.00, the vested 401(k) $38,000.00 — two consecutive statements each under the 45-day rule,
 * the $9,000.00 Sept 14 deposit sourced under R3); 24.6 two insurers' quotes and the 25 % / 0.38 % = $130.47 election Thu Oct 22
 * before the LE carries it; the LE Thu Oct 22 (e-signed, inside its clock; costs expire Thu Nov 5); intent Fri Oct 23 09:14; 24.1
 * the traditional appraisal ordered Fri Oct 23 (after the intent — 24.1 R2, see the discrepancies below); 23.1 DU Mon Oct 26
 * (Approve/Eligible, DTI 45.44 %, LTV 89.99) → 23.2 → 23.3 the conditional approval Mon Oct 26 (valid until Wed Nov 25); the 30-day
 * lock Mon Oct 26 (expires Wed Nov 25 — 21.4 worked example 3) and 29.1's commitment; 24.6 the delegated MI order Mon Oct 26 and the
 * commitment Tue Oct 27; the appraisal inspected Tue Oct 27, received Thu Oct 29 at $460,000 → 24.2 `value_used = lower_of_two`
 * $457,800 and the Reg B copy Fri Oct 30 (24 README INT-O5-3); 24.6 the initial amortization schedule and the HPA dates Oct 1, 2034 /
 * Dec 1, 2035 / Jan 1, 2042 (worked example 1); 22.4 the $10,000.00 gift from Borrower A's mother wired Mon Oct 26 (R5), the seller's
 * $5,000.00 credit inside the 6 % band (R7: base $457,800 → $27,468.00) and the funds-to-close worksheet from the verified rows
 * ($43,997.00 to close; $51,140.18 usable; reserves $45,143.18 ≥ $8,000.00 — R8 worked example 1); 24.4 the agent vetted and the
 * commitment ordered Mon Nov 2; 23.3 clear to close Fri Nov 6 (28.1 worked example 2: PTD cleared Nov 6); 26.2 the RON closing
 * scheduled Mon Nov 9 for Wed Nov 18 10:05 ET; 24.4 the 2021 ALTA commitment and the wire verified Tue Nov 10; 25.2 CD v1 Thu Nov 12
 * e-delivered Fri Nov 13 → earliest consummation Tue Nov 17 (worked example 4) and 22.4's reconciliation to the CD; 24.4 the CPL
 * Mon Nov 16 and the consummation gates; 26.1 the OH purchase eNote set Mon Nov 16 (no H-8); 26.3 the funding opened 08:00 Wed Nov 18;
 * 26.2 the session 10:05: both signers proofed, the eNote signed 10:31 EST = consummation (no rescission on a purchase), the mortgage
 * acknowledged, the Authoritative Copy sealed and registered, the audit trail on file, the execution review passed 11:40; the seller's
 * CD 11:00; 26.3 worked example 5's money (13 × $71.96 = $935.48 prepaid interest; the escrow deposit $1,240.00) — the funding
 * authorized 11:52, the wire released under dual control, the agency's receipt, the disbursement authorization, the disbursement
 * 13:15 → `loan.funded{2026-11-18}`; 24.6 MI activated effective Nov 18; 30.2 boarding through POST /v1/applications/{id}/fund at
 * 15:20 EST with the purchase snapshot (note $412,000 at 6.375 %, MI active, escrow $615.00 + MI $130.47, deposit $1,240.00 — 30.2
 * worked example 2); 30.4's hand-off.
 *
 * Every step is a bus tool the origination sections or the 32.x flows already expose; where the spec's purchase path has no tool
 * the fixture stops short and the gap is named here (and in purchase-lifecycle.test.ts's header). Nothing here asserts the sections'
 * figures — purchase-lifecycle.test.ts does; a phase fails loudly on any non-200 answer. The application's borrowers carry contact
 * e-mails so the borrower API's one-time code links them to their parties; `linkParties` runs between the application row and 20.3's
 * conversion so the 32.x flows find the parties on `application.received`.
 *
 * GAPS — purchase steps for which no bus tool exists, or whose tool refuses the spec's timing; nothing is faked past a gap:
 *   1. 21.1 / 32.2 — no tool writes `application_properties` for a to-be-determined purchase once the contract names the address
 *      (32.2 `confirmField{purchase_contract}` writes `purchase_contracts` and 21.1's six-item event; 32.14's lead flow inserts a
 *      state-only row; `POST /v1/applications` takes the property only at creation). `isTbd` / the record's Property pane keep reading
 *      the TBD row and 24.5's `orderFloodDetermination` (property_id) has nothing to anchor on, so — as in the refinance fixture —
 *      24.5's hazard binder (effective Nov 18, premium on the CD) and the Zone X determination reach 26.3 / 30.2 as facts, not rows.
 *   2. 21.1 `confirmPrefill{value}` for `property_address` does not stamp `intake.property_address` (the item is recorded with
 *      `source = borrower_confirmed_prefill`); the record's address stays null (the state was known from the lead).
 *   3. 24.1 `readDuOffer` cannot parse 23.1's FAKE findings (`value_acceptance_offer` is `{offered, property_value_cents}` where
 *      24.1 reads a string) — the spec's "DU offer first, then the method" order is unreachable, so the appraisal is ordered before
 *      DU (23.1 runs Mon Oct 26 here; 28.1 worked example 2 has it Tue Oct 20).
 *   4. 26.3 rule 6 / 26.3-T8 — wet-state table funding: `authorizeFunding` (requestWarehouseAdvance) refuses unless every checklist
 *      item passes, the executed package included, so the pre-signing subset cannot release the wire before the session (08:55 ET in
 *      worked example 5; SM_O73_WET_FUNDS_AT_TABLE_GATE). The fixture opens the funding 08:00, runs 26.2's `reviewExecution` 11:40,
 *      authorizes 11:52, wires, and issues the disbursement authorization (`notifySettlementAgent{op: disbursement_authorization}`,
 *      the wet-state step) after the agent's receipt; the money figures are the example's.
 *   5. 22.4 B3-4.3-09 — no tool records the EMD's own evidence (the holder's statement / cancelled check): the $5,000.00 deposit is
 *      carried as `emd_offset_cents` on the checking account's `parseStatement` and as `emd_cents` on the worksheet; the cancelled
 *      check is ingested through 22.1 as `emd_evidence` and nothing in 22.4 consumes it.
 *   6. `purchase_contracts.document_id` has a foreign key to `documents` that only the upload route writes; a bus-ingested contract
 *      (22.1 ingestDocument with a non-uuid id) confirms with `document_id = null`.
 *   7. 29.4 / 30.1 delivery and purchase are not driven for the purchase journey (the refinance journey covers the same tools on the
 *      same loan-id grammar); the journey ends at 30.2 boarding and 30.4's hand-off.
 *
 * DISCREPANCIES inside the spec that the fixture resolves (not gaps — a tool exists; two passages disagree):
 *   a. 24 README INT-O5-3 orders the appraisal Tue Oct 20; 24.1 R2 says "the platform orders only after ITP" — the order follows
 *      Fri Oct 23's 09:14 intent.
 *   b. 26.3 worked example 5's worksheet writes the lender credit as $0.00 (net wire $409,824.52) while 20.4 worked example B, 22.4 R8
 *      and the CD carry $515.00; the wire carries what the CD shows → $410,339.52.
 *   c. INT-O5-3 activates MI Thu Nov 19; 30.2 worked example 2 boards at 15:20 EST Nov 18 with OB-009 "MI active" — the insurer
 *      confirms Nov 18 15:05 (effective Nov 18, SM_MI_ACTIVATE_1BD) so the boarding hour is the example's.
 *   d. 22.4 R8 writes 13 days' prepaid interest as $935.47; 26.3 fixes the rounded per diem ($71.96 × 13 = $935.48; 26 README
 *      discrepancy 1) — $935.48 everywhere.
 *   e. 20.4 worked example B quotes BPMI at 0.58 % ($199.13); 24.6 / the LE / the CD carry the elected 25 % plan at 0.38 % = $130.47;
 *      each figure stays where its section puts it.
 *   f. 25.2 / 22.4 — the $8,712.00 total closing costs are decomposed illustratively (the owner's policy carries H's remainder); the
 *      spec gives only the totals ($43,997.00 cash to close). The LE's own G lines ($1,230.00, two months each) make its cash to
 *      close $43,987.00; the CD's $1,240.00 deposit (30.3's aggregate analysis) makes the CD's $43,997.00.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Db } from "../../../infra/db/client.ts";
import { decodeEntityData } from "../../../infra/db/entities.ts";
import { MemoryEventStore, type FixedClock, type DomainEvent } from "../../../kernel/events/index.ts";
import { createCasefile } from "../../../domain/underwriting/ops-23-1.ts";
import { makeMin } from "../../../domain/boarding/min.ts";
import { newDecisionFile } from "../../../domain/application/ops-21-6.ts";
import type { Runtime } from "../../app.ts";

type Actor = { kind: "agent" | "human" | "system"; id: string; role?: string };
export const INTAKE: Actor = { kind: "agent", id: "intake" }; const PRICING: Actor = { kind: "agent", id: "pricing" }; const DISCLOSURE: Actor = { kind: "agent", id: "disclosure" }; const VERIFICATION: Actor = { kind: "agent", id: "verification" }; const UNDERWRITER: Actor = { kind: "agent", id: "underwriter" }; const VALUATION: Actor = { kind: "agent", id: "valuation" }; const CLOSER: Actor = { kind: "agent", id: "title-closing" }; const FUNDER: Actor = { kind: "agent", id: "funder" }; const FRAUD_RISK: Actor = { kind: "agent", id: "fraud-risk" }; const COMPLIANCE: Actor = { kind: "agent", id: "compliance-tester" }; const FUNDING: Actor = { kind: "agent", id: "funding" }; const BORROWER_APP: Actor = { kind: "agent", id: "borrower-app" };
export const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" }; export const MLO: Actor = { kind: "human", id: "u-mlo-okonkwo", role: "mlo_of_record" }; const APPROVER: Actor = { kind: "human", id: "u-funding-approver", role: "funding_approver" };
/** America/New_York: EDT (−04:00) through Sat Oct 31, 2026, EST (−05:00) from Sun Nov 1. */
export const EDT = (date: string, hhmm: string): string => new Date(`${date}T${hhmm}:00-04:00`).toISOString();
export const EST = (date: string, hhmm: string): string => new Date(`${date}T${hhmm}:00-05:00`).toISOString();
export const ET = (date: string, hhmm: string): string => (date >= "2026-11-01" ? EST(date, hhmm) : EDT(date, hhmm));
type ToolResult = { output: Record<string, unknown>; events: (DomainEvent & { applicationId?: string; loanId?: string })[]; decisions: unknown[]; escalations: { id: string; kind: string }[] };

export interface PurchaseJourneyOptions {
  readonly runtime: Runtime; readonly db: Db; readonly base: string; readonly token: string; readonly clock: FixedClock; readonly borrowerEmail: string; readonly coBorrowerEmail: string; readonly partnerPartyId: string;
  /** Runs once the application row exists and before 20.3 converts the lead (`application.received`): the test signs the borrowers in so the flows find their parties. */
  readonly linkParties?: (appId: string) => Promise<void>;
  /** Awaited after every bus call when the 32.x flows share the runtime (`router.flows.settle`): a flow reacting to the call's events may run the owning tools itself (32.3 C1 classifies the contract), and two writers on one entity row collide. */
  readonly settle?: () => Promise<void>;
}

/** The spec's purchase fixture, as one class of phases; the ids every phase shares are public so a test can read the record between them. */
export class PurchaseJourney {
  readonly o: PurchaseJourneyOptions;
  readonly leadId = randomUUID(); readonly R = this.leadId.slice(0, 8);
  appId = ""; loanId = ""; quoteId = ""; lockId = ""; commitmentId = ""; commitmentExpiresOn = ""; leDataHash = ""; creditReportId = ""; casefileId = ""; valuationOrderId = ""; appraisalId = ""; titleOrderId = ""; miCertificateId = ""; miCertificateNumber = ""; miQuoteId = ""; cdDisclosureId = ""; closingSetId = ""; noteDataHash = ""; abIds: string[] = [];
  /** 22.4's rows: the asset ids, the gift record, the worksheet 22.4 R8 built (the test reads its figures) and the CD reconciliation. */
  readonly ASSET = { checking: `chk-p-${this.R}`, savings: `sav-p-${this.R}`, retirement: `ret-p-${this.R}`, gift: `gift-p-${this.R}` }; giftId = ""; worksheetId = ""; worksheet: Record<string, unknown> = {};
  /** 30.2's answer to POST /v1/applications/{id}/fund (loan id, status, the opening set id, the OB/OW validations) — the test asserts it the way lifecycle.test.ts does. */
  boardResult: Record<string, unknown> = {};
  /** The contract's 22.1 document id: a bus-ingested document has an entity row, not a `documents` table row — 32.2 links `purchase_contracts.document_id` (a FK to `documents`) only for the borrower API's uploads (a uuid), so the bus id is a plain string. */
  readonly contractDocumentId = `doc-contract-${this.R}`;
  /** 26.1's computed note terms (the late-charge terms the OH note carries — 30.2's OB-002 hashes the same fields). */
  noteTerms: Record<string, unknown> = {};
  readonly PARTNER_ID = "partner-1"; readonly PARTNER_NAME = "Partner Bank"; readonly QUOTE = `Q-B-${this.R}`; readonly FUNDING_ID = `F-P-${this.R}`; readonly CLOSING_ID = `CLS-P-${this.R}`; readonly SESSION_ID = `SES-P-${this.R}`; readonly CONSENT_ID = `CONS-P-${this.R}`; readonly decisionId = `D-PURCH-CA-${this.R}`;
  readonly MIN = makeMin("1000123", String(2_000_000_000 + Number(BigInt("0x" + this.leadId.replace(/-/g, "").slice(8, 16)) % 7_999_999_999n)));
  private readonly sheets = new Set<string>();
  constructor(o: PurchaseJourneyOptions) { this.o = o; }
  private get clock() { return this.o.clock; }
  /** The fixture's clock only moves forward: a phase that starts "earlier" than the last call (a sheet published 06:35 after a 09:05 identity pass) keeps the later reading, so the log's `occurred_at` is monotone. */
  private at(iso: string): void { if (iso > this.clock.now()) this.clock.set(iso); }
  async call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const r = await fetch(this.o.base + path, { method, headers: { authorization: `Bearer ${this.o.token}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)) } : {}) });
    const out = { status: r.status, body: (await r.json()) as Record<string, unknown> };
    if (this.o.settle) await this.o.settle();
    return out;
  }
  async tool(scope: { loan?: string; app?: string }, process: string, name: string, input: Record<string, unknown>, actor: Actor = INTAKE): Promise<ToolResult> {
    const path = scope.app ? `/v1/applications/${scope.app}/tools/${process}/${name}` : scope.loan ? `/v1/loans/${scope.loan}/tools/${process}/${name}` : `/v1/tools/${process}/${name}`;
    const r = await this.call("POST", path, { actor, input });
    assert.equal(r.status, 200, `${process} ${name}: ${JSON.stringify(r.body).slice(0, 900)}`);
    return r.body as unknown as ToolResult;
  }
  /** The application's log rows of one type (the fixture reads what a flow may already have done before doing it itself). */
  async has(type: string, where: (payload: Record<string, unknown>) => boolean = () => true): Promise<boolean> { return (await this.eventsOf(`application_id = $1 AND type = $2`, [this.appId, type])).some((e) => where(e.payload)); }
  async entity(kind: string, id: string): Promise<Record<string, unknown> | null> { const rows = await this.o.db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = $1 AND id = $2`, [kind, id]); return rows[0] ? decodeEntityData(rows[0].data) : null; }
  async eventsOf(where: string, params: unknown[]) { return this.o.db.query<{ type: string; loan_id: string | null; application_id: string | null; sequence: string; occurred_at: string; payload: Record<string, unknown> }>(`SELECT type, loan_id, application_id, sequence::text, occurred_at, payload FROM loan_events WHERE ${where} ORDER BY loan_events.sequence`, params); }   // the table column, not the text-cast output column of the same name (which would order lexicographically past 999 events)
  /** 22.1: a document on the bus (ingest + classify), the way the paystub and the statements arrive. */
  private async document(id: string, doc_class: string, subject: string, pages = 2): Promise<void> {
    const scope = { app: this.appId };
    await this.tool(scope, "22.1", "ingestDocument", { document_id: id, source_channel: "borrower_upload", sha256: `sha-${id}`, subject_borrower_id: subject, applicant_borrower_ids: ["B1", "B2"], page_count: pages }, VERIFICATION);
    await this.tool(scope, "22.1", "classifyDocument", { document_id: id, doc_class, confidence: 0.98 }, VERIFICATION);
  }

  // ---- the property, the people
  readonly ADDRESS = "1187 Oakwood Ave, Columbus, OH 43206"; readonly ADDRESS_SHORT = "1187 Oakwood Ave, Columbus OH"; readonly LEGAL = "Lot 14, Oakwood Heights Subdivision, Plat Book 71, page 33, Franklin County records"; readonly APN = "010-012345";
  readonly A = "Casey Purchaser"; readonly B = "Riley Purchaser"; readonly SELLER = "Morgan Vendor"; readonly DONOR = "Dana Purchaser";
  readonly AGENT_PARTY = "P-TITLE-OH-1"; readonly UNDERWRITER_PARTY = "P-TITLE-UW-OH-1"; readonly NOTARY = { party_id: "N-OH-1", commission_state: "OH", commission_number: "OH-2026-04417", physical_location_state: "OH" };
  readonly ELIGIBILITY = [{ settlement_agent_party_id: this.AGENT_PARTY, county_fips: null, ron_capable: true, ipen_capable: true, erecording_submitter: true, platforms: ["Snapdocs"], remote_witness_service: false, verified_at: "2026-10-20T00:00:00Z", verified_by: "title-closing" }];
  readonly SIGNERS = [{ party_id: "B1", esign_consented: true, identity_proofing_possible: true }, { party_id: "B2", esign_consented: true, identity_proofing_possible: true }];

  // ---- 20.4: worked example B's sheet, cost schedule and quote inputs (verbatim from src/domain/leads-pricing/20-4.spec.test.ts)
  private grid30 = (rows: [string, string][]) => rows.map(([r, p]) => ({ product_code: "FRM30", term_months: 360, note_rate_pct: r, lock_period_days: 30, price: p }));
  readonly PRICES = this.grid30([["6.750", "102.250"], ["6.625", "101.875"], ["6.500", "101.500"], ["6.375", "101.000"], ["6.250", "100.500"], ["6.125", "100.000"]]);
  private cost = (fee_code: string, description: string, mismo: string, le_section: string, vendor: string, amount_cents: string, provider_source = "creditor_selected_third_party", shoppable = false, methods?: string[]) => ({ fee_code, description, mismo_fee_type: mismo, le_section, vendor, amount_cents, provider_source, shoppable, ...(methods ? { valuation_methods: methods } : {}) });
  /** OH / purchase / traditional — Σ $2,774.00. */
  readonly COST_ITEMS = [this.cost("credit_report", "Credit report", "CreditReportFee", "B_cannot_shop", "CRA", "7500"), this.cost("appraisal_traditional", "Appraisal (1004)", "AppraisalFee", "B_cannot_shop", "AMC", "65000", "creditor_selected_third_party", false, ["traditional"]), this.cost("flood_determination", "Flood determination", "FloodCertification", "B_cannot_shop", "FloodCo", "1200"), this.cost("tax_service", "Tax service", "TaxServiceFee", "B_cannot_shop", "TaxSvc", "8500"),
    this.cost("title_lenders_policy", "Lender's title policy", "TitleLendersCoveragePremium", "C_can_shop", "Buckeye Title", "85000", "list_provider", true), this.cost("settlement_agent_fee", "Settlement agent fee", "TitleSettlementAgentFee", "C_can_shop", "Buckeye Title", "55000", "list_provider", true), this.cost("title_endorsements", "Endorsements", "TitleEndorsementFee", "C_can_shop", "Buckeye Title", "10000", "list_provider", true), this.cost("title_search", "Title search", "TitleAbstractOrSearchFee", "C_can_shop", "Buckeye Title", "11000", "list_provider", true),
    this.cost("recording_fee", "Recording fees", "RecordingFeeForDeed", "E_taxes_gov", "Franklin County", "9400", "government"), this.cost("ron_notary", "RON / notary", "NotaryFee", "B_cannot_shop", "RON vendor", "20000"), this.cost("mers_enote", "MERS eRegistry / eNote", "MERSRegistrationFee", "B_cannot_shop", "MERS", "4800")];
  /** Purchase, $412,000 on a $457,800 contract (LTV 89.995 → 90.00 %), score 705 Classic FICO, Franklin County OH, BPMI standard 25 %, HomeReady-eligible FTHB, 30-day lock, Purchase Ready Mon Dec 7, 2026. The 0.58 %/yr BPMI is 20.4's illustrative estimate; 24.6's insurer quote (0.38 %) is what the LE and the CD carry (discrepancy e). */
  readonly QUOTE_INPUTS = { product_code: "FRM30", term_months: 360, amortization: "fixed", transaction_type: "purchase", occupancy: "primary", property_type: "sfr", units: 1, loan_amount_cents: "41200000", value_cents: "45780000", purchase_price_cents: "45780000", representative_score: 705, score_model: "classic_fico", score_source: "tri_merge_2026-10-20", borrower_score_models: ["classic_fico"],
    state: "OH", county: "Franklin", county_limit_cents: "83275000", subordinate_financing_cents: "0", mi_option: "standard", homeready: true, homeready_evaluation: { eligible: true, source: "ami_api", ami_pct: 72, evaluated_at: EDT("2026-10-16", "10:00") }, first_time_homebuyer: true, fthb_ami_waiver: false, dts_waiver: false, very_low_income: false, lock_period_days: 30, expected_purchase_ready_date: "2026-12-07", escrowed: true, valuation_method: "traditional", borrower_pays_third_party_costs: false,
    taxes_annual_cents: "540000", insurance_annual_cents: "144000", mi_annual_rate_pct: "0.58", assumed_disbursement_date: null, first_payment_date: null };

  // ---- 22.1 / 32.3 C1: the contract's own field list (the FAKE extractor reads it as the document's fields)
  readonly CONTRACT = { property_address: this.ADDRESS, purchase_price_cents: "45780000", contract_date: "2026-10-15", closing_date: "2026-11-18", earnest_money_cents: "500000", earnest_money_holder: "Buckeye Title Agency LLC", financing_contingency_date: "2026-11-06", appraisal_contingency_date: "2026-11-02", seller_concessions_cents: "500000", seller_names: [this.SELLER] };

  // ---- 21.2: the H-24 (purchase) issued Thu Oct 22 from the Tue Oct 20 estimates: 13 days' prepaid interest at $71.96; the escrow at $520.00 + $95.00 for two months; the owner's policy as H; the elected BPMI $130.47
  private fee = (fee_code: string, description: string, le_section: string, mismo_fee_type: string, amount_cents: string, provider_source: string, shoppable: boolean, estimate_source: string, estimate_source_ref: string, finance_charge: boolean) => ({ fee_code, description, le_section, mismo_fee_type, amount_cents, provider_source, shoppable, estimate_source, estimate_source_ref, estimated_at: "2026-10-20", finance_charge });
  readonly LE_FEES = [this.fee("appraisal", "Appraisal Fee to AMC", "B_cannot_shop", "AppraisalFee", "65000", "creditor_selected_third_party", false, "vendor_quote", "AMC-Q-91204", false), this.fee("credit_report", "Credit Report Fee", "B_cannot_shop", "CreditReportFee", "7500", "creditor_selected_third_party", false, "fee_schedule", "N2-price-list-2026-09", false),
    this.fee("flood_cert", "Flood Determination Fee", "B_cannot_shop", "FloodCertification", "1200", "creditor_selected_third_party", false, "fee_schedule", "N6-flood-2026-09", false), this.fee("tax_service", "Tax Service Fee", "B_cannot_shop", "TaxServiceFee", "8500", "creditor_selected_third_party", false, "fee_schedule", "tax-svc-2026-09", true), this.fee("mers_enote", "MERS eRegistry / eNote", "B_cannot_shop", "MERSRegistrationFee", "4800", "creditor_selected_third_party", false, "fee_schedule", "mers-2026-09", true),
    this.fee("title_lenders_policy", "Title – Lender's Title Policy", "C_can_shop", "TitleLendersCoveragePremium", "139500", "list_provider", true, "vendor_quote", "N7-rate-engine-2026-10-20", false), this.fee("title_settlement", "Title – Settlement Agent Fee", "C_can_shop", "TitleSettlementAgentFee", "55000", "list_provider", true, "vendor_quote", "N7-rate-engine-2026-10-20", false), this.fee("title_endorsements", "Title – Endorsements", "C_can_shop", "TitleEndorsementFee", "12500", "list_provider", true, "vendor_quote", "N7-rate-engine-2026-10-20", false),
    this.fee("recording", "Recording Fees", "E_taxes_gov", "RecordingFeeForMortgage", "15000", "government", false, "county_table", "franklin-recording-2026", false),
    this.fee("prepaid_interest", "Prepaid Interest ($71.96 per day for 13 days @ 6.375%)", "F_prepaids", "PrepaidInterest", "93548", "creditor", false, "pricing_engine", "disbursement-2026-11-18", true), this.fee("hoi_premium", "Homeowner's Insurance Premium (12 mo.)", "F_prepaids", "HomeownersInsurancePremium", "138000", "none", false, "borrower_stated", "quote-2026-10-19", false),
    this.fee("escrow_taxes", "Property Taxes $520.00 per month for 2 mo.", "G_initial_escrow", "PropertyTaxes", "104000", "none", false, "tax_bill", "franklin-2026", false), this.fee("escrow_hoi", "Homeowner's Insurance $95.00 per month for 2 mo.", "G_initial_escrow", "HomeownersInsurance", "19000", "none", false, "insurance_policy", "quote-2026-10-19", false),
    this.fee("owners_title_policy", "Title – Owner's Title Policy (optional)", "H_other", "TitleOwnersCoveragePremium", "206652", "list_provider", true, "vendor_quote", "N7-rate-engine-2026-10-20", false), this.fee("lender_credit", "Lender Credits", "J_lender_credit", "LenderCredit", "-51500", "creditor", false, "pricing_engine", this.QUOTE, false)];
  /** Issued Thu Oct 22 (§1026.37(a)(13): the estimated closing costs expire 10 business days after issue — Thu Nov 5 at 5 p.m., the day REGZ_1026_37A13_COSTS_EXPIRE_10BD lands on); cash to close from its own lines: $45,800.00 + $8,702.00 − $5,000.00 (EMD) − $5,000.00 (seller credit) − $515.00 = $43,987.00. */
  readonly LE_RENDER = () => ({ application_id: this.appId, disclosure_id: `LE-${this.appId.slice(0, 8)}`, as_of: "2026-10-22", loan_cents: "41200000", term_months: 360, transaction_type: "purchase", product: "Fixed Rate", pricing: { quote_id: this.QUOTE, rate_pct: "6.375", price: "101.000", points_cents: "0", lender_credit_cents: "51500", locked: false }, fees: this.LE_FEES, mi_monthly_cents: "13047",
    applicants: [this.A, this.B], property_address: this.ADDRESS, estimated_value_cents: "45780000", creditor: { name: "Partner Bank, N.A.", nmlsr_id: "123456", email: "loans@partnerbank.example", phone: "(800) 555-0155" }, loan_officer: { name: "Ada Okonkwo", nmlsr_id: "987654" }, escrow_monthly_cents: "61500", cash_to_close_cents: "4398700", costs_expire_display: "11/05/2026 at 5:00 p.m. EST" });
  readonly ESIGN_CONSENT = { id: `CNS-ESIGN-P-${this.R}`, scope: ["disclosures", "notices", "closing_package"], granted_at: EDT("2026-10-19", "18:47") };
  /** 21.1 worked example 2: A affirms joint intent 18:52, B 20:31 EDT Mon Oct 19 (web checkbox, a separate screen from the accuracy attestation); the six items 20:44. */
  readonly JOINT_INTENT = { trid_received_at: EDT("2026-10-19", "20:44"), borrowers: [{ id: "B1", joint_intent_affirmed_at: EDT("2026-10-19", "18:52"), added_at: EDT("2026-10-19", "18:40") }, { id: "B2", joint_intent_affirmed_at: EDT("2026-10-19", "20:31"), added_at: EDT("2026-10-19", "20:15") }] };
  readonly SDN_LISTS = [{ list: "ofac_sdn", version: "SLS-2026-10-19", published_on: "2026-10-19" }, { list: "ofac_consolidated", version: "CONS-2026-10-19", published_on: "2026-10-19" }];
  readonly BORROWER_IDENTITIES = [{ borrower_id: "B1", last_name: "Purchaser", suffix: null, ssn_last4: "4120" }, { borrower_id: "B2", last_name: "Purchaser", suffix: null, ssn_last4: "8831" }];
  /** 23.1's ULAD snapshot for the purchase before the appraisal: the contract price stands as the value (LTV 89.99); qualifying income $8,200.00/month, obligations $3,726.08 (DTI 45.44 % — 22 README O3-IT2). */
  readonly ULAD = () => ({ application_id: this.appId, loan_purpose: "purchase", occupancy: "principal_residence", product: "fixed_30", amortization: "fixed", loan_term: 360, property_type: "sfr_detached", sales_price_cents: "45780000", appraised_value_cents: "45780000", loan_amount_cents: "41200000", note_rate_pct: "6.375", qualifying_income_cents: "820000", total_obligations_cents: "372608", borrowers: this.BORROWER_IDENTITIES, max_ltv_pct: "97.00" });
  private msg = (id: string, category: string, text: string, borrower_id: string | null = null) => ({ id, category, text, borrower_id });
  /** 23.2's purchase findings: the catalog's verification messages the interpretation opens PTD conditions from — assets, reserves ($8,000.00 — 23.1 worked example 4), the EMD, the contract and the rest. */
  readonly DU_MESSAGES = [this.msg("V1001", "verification", "Verify base income with the most recent paystub (30 days) and W-2 (1 year)", "B1"), this.msg("V1003", "verification", "Verbal verification of employment within 10 business days of the note date", "B1"), this.msg("V1002", "verification", "Verify assets with two consecutive monthly bank statements (60 days of activity)", "B1"), this.msg("V1005", "verification", "Reserves Required to be Verified $8,000.00"), this.msg("V1007", "verification", "Verify the earnest money deposit with the holder's statement or the cancelled check"), this.msg("V1008", "verification", "Obtain evidence of hazard insurance coverage"), this.msg("V1009", "verification", "Obtain the title commitment"), this.msg("V1011", "verification", "Obtain the executed purchase contract and all addenda"), this.msg("V1012", "verification", "Verify the borrowers' identity"), this.msg("V1014", "verification", "Obtain the flood zone determination")];
  readonly DU_FACTS = { transaction_type: "purchase", product: "homeready", term_months: 360, ltv_x100: 8999, loan_amount_cents: "41200000", units: 1, county_limit_cents: "83275000", score_model: "classic_fico", borrower_ids: ["B1", "B2"], all_occupying_first_time: true, all_borrowers_first_time: true, du_no_tradelines: false, closing_date: "2026-11-18" };
  readonly QM_OPEN = { qm_type: "general_safe_harbor", apr_test_pass: true, pf_pass: true, product_tests_pass: true, consider_verify_complete: true, consider_verify_missing: [], stage: "le", apor_stale: false, blocked_reason: null, computed_from_final_cd: false };
  readonly GUARD = { policy_outcome: "proceed", qm_facts: this.QM_OPEN, is_hoepa: false, is_state_high_cost: false, open_red_flag_investigations: 0 };
  /** 23.3's comprehensive risk assessment: DTI 45.44 %, residual income $4,473.92, funds to close $43,997.00 (22.4 R8), 12 months' reserves after closing, LTV 89.99 traditional. */
  readonly RISK = { credit: { score_model: "classic_fico", representative_score: 705, history_summary: "no 30-day lates in 24 months; revolving utilization 28%; student loan and auto lease current" }, capacity: { dti_bps: 4544, residual_income_cents: "447392", income_sources: ["base_salary"], income_reconciled_to_22_3: true }, capital: { funds_to_close_cents: "4399700", reserves_months: 12, assets_reconciled_to_22_4: true },
    collateral: { ltv_x100: 8999, cltv_x100: 8999, hcltv_x100: 8999, valuation_method: "traditional", cu_score: null }, du_risk_factors: ["purchase", "first_time_homebuyer", "ltv_over_80"], eligibility_outside_du_confirmed: true, legal_compliance_confirmed: true };
  /** Validity components: credit 120 days from the Oct 20 report (Feb 17, 2027), the lock Wed Nov 25, the appraisal 4 months from its Oct 27 effective date, DU close-by Dec 7 → the approval is valid until Nov 25, 2026. */
  readonly VALIDITY = { credit_expires_at: "2027-02-17", lock_expires_at: "2026-11-25", valuation_expires_at: "2027-02-27", du_close_by_date: "2026-12-07" };
  readonly CTC_CODES = ["CTC_DU_FINAL_MATCH", "CTC_PTD_ALL_CLEARED", "CTC_NO_OPEN_INVESTIGATION", "CTC_CREDIT_VALID", "CTC_DU_CLOSE_BY", "CTC_ASSETS_CASH_TO_CLOSE", "CTC_VALUATION", "CTC_PROPERTY_PROJECT", "CTC_TITLE", "CTC_INSURANCE_FLOOD", "CTC_MI", "CTC_COMPLIANCE", "CTC_EDUCATION", "CTC_LOCK", "CTC_IDENTITY_OFAC", "CTC_QC_PREFUNDING", "CTC_MLO_APPROVALS", "CTC_REGB_TIMING", "CTC_DECISION_VALID"];
  /** Every item passes; MI evidenced by the 24.6 commitment, homeownership education by the HomeView certificate of Fri Oct 30 (23.2 rule 2), the assets by 22.4's worksheet. */
  readonly CTC_FACTS = () => Object.fromEntries(this.CTC_CODES.map((c) => [c, { status: "pass", ...(c === "CTC_INSURANCE_FLOOD" ? { evidence_ref: "doc-hoi-binder-1" } : c === "CTC_MI" ? { evidence_ref: this.miCertificateId } : c === "CTC_EDUCATION" ? { evidence_ref: "doc-homeview-cert-1" } : c === "CTC_ASSETS_CASH_TO_CLOSE" ? { evidence_ref: this.worksheetId } : {}) }]));
  // ---- 24.1: Franklin County URAR benchmark, the AMC's OH registration, the order payload (no value information — AIR §1.2)
  readonly FEE_TEST = { benchmark_id: "bench-oh-049-urar", customary_and_reasonable: true, reason: "gross $650.00 within the p25–p75 band ($500.00–$700.00) of the Franklin County URAR survey", gross_cents: "65000", appraiser_share_cents: "55000", amc_share_cents: "10000", held_for_requote: false };
  readonly AMC_REG = { amc_registration_id: `amcreg-oh-${this.R}`, amc_party_id: "amc-1", state: "OH", registration_number: "AMC-OH-2211", expires_on: "2027-06-30", asc_amc_registry_status: "active", verified_at: EDT("2026-10-01", "09:00") };
  readonly ORDER_PAYLOAD = { address: this.ADDRESS, legal_description: this.LEGAL, unit_count: 1, occupancy: "primary", transaction_type: "purchase", access_contact: { name: "Listing agent (seller side)", phone: "614-555-0177" }, hoa_contact: null, scope: "traditional", form_code: "urar_uad36", uad_version: "3.6", purchase_contract_document_ids: [this.contractDocumentId] };
  readonly APPRAISER = { party_id: "APR-OH-1", license_state: "OH", license_type: "certified_residential", license_number: "OH-CR-4410", license_expires_on: "2027-09-30", asc_registry_status: "active", asc_registry_checked_on: "2026-10-20" };
  // ---- 24.2: the UAD 3.6 package and the review checklist (the appraisal at $460,000 on the $457,800 contract → lower_of_two)
  readonly PACKAGE = { uad_version: "3.6", has_xml: true, has_pdf: true, has_images: true, lender_client_party_id: this.PARTNER_ID, partner_party_id: this.PARTNER_ID, appraiser_party_id: this.APPRAISER.party_id, ordered_appraiser_party_id: this.APPRAISER.party_id, appraiser_license_active: true, ordered_form: "urar_uad36", form: "urar_uad36" };
  readonly CHECKLIST = { closed_comparables: 3, adjustments_explained: true, market_conditions_consistent: true, gla_sqft: 1860, application_gla_sqft: 1860, units: 1, application_units: 1, condition_rating: "C3", quality_rating: "Q3", subject_to: false, narrative: "The subject is a well-maintained single-family residence in an established Columbus subdivision; three closed sales within six months support the value." };
  // ---- 24.6: two insurers' quotes Thu Oct 22 (standard 25 % and the 12 % minimum option); the standard MGIC monthly plan is elected
  readonly MI_QUOTES = () => [{ mi_company_code: "06", plan: "bpmi_monthly", coverage_pct: 25, coverage_option: "standard", rate_bps: 38, renewal_type: "constant", refundable: false, quoted_at: EDT("2026-10-22", "09:00"), expires_at: EDT("2027-01-20", "09:00"), quote_id: `MIQ-06-${this.R}` }, { mi_company_code: "33", plan: "bpmi_monthly", coverage_pct: 25, coverage_option: "standard", rate_bps: 40, renewal_type: "constant", refundable: false, quoted_at: EDT("2026-10-22", "09:00"), expires_at: EDT("2027-01-20", "09:00"), quote_id: `MIQ-33-${this.R}` },
    { mi_company_code: "06", plan: "bpmi_monthly", coverage_pct: 12, coverage_option: "minimum", rate_bps: 30, renewal_type: "constant", refundable: false, quoted_at: EDT("2026-10-22", "09:00"), expires_at: EDT("2027-01-20", "09:00"), quote_id: `MIQ-06-min-${this.R}` }];
  // ---- 25.2: CD v1 (Thu Nov 12) fee lines — J = $8,712.00 as 22.4 R8 states it (the owner's policy in H is the remainder); cash to close $43,997.00
  readonly CD_FEES = () => [{ fee_code: "appraisal", description: "Appraisal fee", amount_cents: "65000", section: "B_cannot_shop", tolerance_class: "zero", source_id: `SRC-CREDITOR-P-${this.R}` }, { fee_code: "credit_report", description: "Credit report fee", amount_cents: "7500", section: "B_cannot_shop", tolerance_class: "zero", source_id: `SRC-CREDITOR-P-${this.R}` }, { fee_code: "flood_cert", description: "Flood determination fee", amount_cents: "1200", section: "B_cannot_shop", tolerance_class: "zero", source_id: `SRC-CREDITOR-P-${this.R}` }, { fee_code: "tax_service", description: "Tax service fee", amount_cents: "8500", section: "B_cannot_shop", tolerance_class: "zero", source_id: `SRC-CREDITOR-P-${this.R}` }, { fee_code: "mers_enote", description: "MERS eRegistry / eNote", amount_cents: "4800", section: "B_cannot_shop", tolerance_class: "zero", source_id: `SRC-CREDITOR-P-${this.R}` },
    { fee_code: "title_lender_policy", description: "Title — Lender's policy", amount_cents: "139500", section: "C_can_shop", tolerance_class: "ten_percent", source_id: `SRC-SA-P-${this.R}` }, { fee_code: "settlement_fee", description: "Title — Settlement fee", amount_cents: "55000", section: "C_can_shop", tolerance_class: "ten_percent", source_id: `SRC-SA-P-${this.R}` }, { fee_code: "title_endorsements", description: "Title — Endorsements (ALTA 8.1)", amount_cents: "12500", section: "C_can_shop", tolerance_class: "ten_percent", source_id: `SRC-SA-P-${this.R}` }, { fee_code: "recording", description: "Recording fees", amount_cents: "15000", section: "E_taxes_gov", tolerance_class: "ten_percent", source_id: `SRC-SA-P-${this.R}` },
    { fee_code: "prepaid_interest", description: "Prepaid interest ($71.96 per day from 11/18/2026 to 12/01/2026)", amount_cents: "93548", section: "F_prepaids", tolerance_class: "unlimited", source_id: `SRC-CREDITOR-P-${this.R}` }, { fee_code: "hoi_premium", description: "Homeowner's insurance premium (12 mo.)", amount_cents: "138000", section: "F_prepaids", tolerance_class: "unlimited", source_id: `SRC-CREDITOR-P-${this.R}` },
    { fee_code: "escrow_deposit", description: "Initial escrow payment at closing", amount_cents: "124000", section: "G_initial_escrow", tolerance_class: "unlimited", source_id: `SRC-ESCROW-P-${this.R}` }, { fee_code: "owners_title_policy", description: "Title — Owner's policy (optional)", amount_cents: "206652", section: "H_other", tolerance_class: "unlimited", source_id: `SRC-SA-P-${this.R}` }];
  // ---- 26.1 / 26.2 / 26.3
  readonly CLOSING_SNAPSHOT = () => ({ application_id: this.appId, cd_version: 1, du_submission_number: "DU-1", lock_id: this.lockId, partner: { legal_name: this.PARTNER_NAME, nmlsr_id: "123456", mers_org_id: "1000123" }, mlo_of_record: { name: "Ada Okonkwo", nmlsr_id: "987654" }, servicer: { name: "Supermortgage LLC", payment_address: "PO Box 1, Phoenix AZ 85001" },
    state: "OH", county: "Franklin", property_address: this.ADDRESS, legal_description: this.LEGAL, transaction_type: "purchase", occupancy: "primary", property_type: "sfr", units: 1, vesting: "joint", vesting_text: `${this.A} and ${this.B}, joint tenants with right of survivorship`,
    borrowers: [{ party_id: "B1", legal_name: this.A, credit_used: true, on_title: true, capacities: ["borrower"] }, { party_id: "B2", legal_name: this.B, credit_used: true, on_title: true, capacities: ["borrower"] }],
    loan_amount_cents: "41200000", note_rate_pct: "6.375", term_months: 360, product: "fixed", note_date: "2026-11-18", scheduled_disbursement_date: "2026-11-18", scheduled_closing_date: "2026-11-18", escrowed: true, rescindable: false,
    enote_default: true, partner_emortgage_approved: true, ron_authorized_state: true, settlement_agent_eclosing_eligible: true, borrower_declined_electronic: false, min: this.MIN });
  readonly DOCGEN_GATE = { final_cd_delivered: true, approval_ptd_cleared: true, trust_poa_gate_open: true, compliance_pass_cd_gate_open: true, lock_status: "active", lock_expires_on: "2026-11-25", closing_date: "2026-11-18" };
  readonly CLOSING_CONSENT = { consent_id: this.CONSENT_ID, kind: "esign", scope: ["disclosures", "closing_package"], granted_at: EDT("2026-10-19", "18:47"), withdrawn_at: null, hw_sw_statement_version: "2026-09", access_demonstrated: true, paper_option_disclosed: true };
  /** No rescission on a purchase: no H-8 in the package; the LE's seventh specific business day after Oct 22 is Fri Oct 30; the CD's third is Tue Nov 17. */
  readonly PRE_SESSION_FACTS = { ctc: { ctc_issued: true, checklist_passed: true, decision_status: "active" }, le: { earliest_consummation_date: "2026-10-30" }, cd: { earliest_consummation_date: "2026-11-17", receipts_complete: true }, signing_package: [{ consumer_id: "B1", copies: 1, channel: "ron", material_disclosures_in_package: true, receipt_capture: true }, { consumer_id: "B2", copies: 1, channel: "ron", material_disclosures_in_package: true, receipt_capture: true }], fraud_hold: { fraud_hold: false }, compliance_consummate_gate_open: true, vvoe_within_10bd: true, mi_commitment_valid: true, lock_valid_through_closing: true };
  readonly VERIFIED_WIRE = { verification_id: `WV-P-${this.R}`, beneficiary_party_id: this.AGENT_PARTY, beneficiary_name: "Buckeye Title Agency LLC Trust Account", instructions_hash: "h-verified-oh", verified_at: EST("2026-11-10", "10:00"), expires_at: EST("2026-12-10", "10:00"), blocks_disbursement: false, change_detected_at: null, callback_number_source: "alta_registry", cpl_agent_party_id: this.AGENT_PARTY, ofac_screen_ref: "OFAC-P-1", ofac_clear: true };
  /** The executed set 26.2's post-signing review reads (the eNote, the Ohio mortgage acknowledged by RON, the final 1003): every signature attributable and dated, no handwritten change, the MIN on the instruments. */
  readonly EXECUTED_DOCUMENTS = () => {
    const signers = [{ party_id: "B1", typed_name: this.A, capacity: "borrower" }, { party_id: "B2", typed_name: this.B, capacity: "borrower" }];
    const signatures = [{ party_id: "B1", signed_name: this.A, attributable: true, dated: true }, { party_id: "B2", signed_name: this.B, attributable: true, dated: true }];
    const cert = { venue: true, date: true, notary_name: true, commission_expiry: true, seal: true, ron_statement: true };
    return [{ closing_document_id: `DOC-ENOTE-P-${this.R}`, kind: "enote", form: "electronic", required_signers: signers, signatures, notarized: false, notarial_certificate: null, witness_count_required: 0, witnesses: 0, handwritten_changes: [], recordable: false, min_present: true, cover_sheet: false },
      { closing_document_id: `DOC-MTG-P-${this.R}`, kind: "security_instrument", form: "electronic", required_signers: signers, signatures, notarized: true, notarial_certificate: cert, witness_count_required: 0, witnesses: 0, handwritten_changes: [], recordable: true, min_present: true, cover_sheet: true },
      { closing_document_id: `DOC-1003-P-${this.R}`, kind: "final_1003", form: "electronic", required_signers: signers, signatures, notarized: false, notarial_certificate: null, witness_count_required: 0, witnesses: 0, handwritten_changes: [], recordable: false, min_present: false, cover_sheet: false }];
  };
  /** 26.3 worked example 5's funding-condition facts (wet state, purchase — rescission not applicable, no payoffs): the executed package reviewed 11:40 ET Wed Nov 18 (26.2 `closing.execution_review.passed`), the gift transfer verified (22.4), the worksheet reconciled to the CD (22.4 R8), every other item passing or n/a. */
  readonly FUNDING_FACTS = (as_of: string) => ({ as_of, funding: { funding_type: "wet", transaction_type: "purchase", disbursement_date: "2026-11-18", release_date: "2026-11-18", note_date: "2026-11-18", authorized: false },
    loan: { ltv_pct: 90, sfha: false, project: false, enote: true, tx_50a6: false, record_before_fund: false }, execution: { review_passed: true, all_docs_signed: true, blocking_defects: 0, package_returned: true }, cd: { consummated_version: 1, delivered_with_receipt: true, signed_copy_in_documents: true }, identity: { all_signers_proofed: true },
    rescission: { status: "not_applicable", expires_at: null, reasonably_satisfied_at: null, waiver_id: null, now: as_of }, hazard: { hazard_status: "verified", effective_date: "2026-11-18", transaction_type: "purchase", policy_in_force: true, premium_on_cd: true },
    title: { cpl_open: true, commitment_open: true }, vvoe: { verified_on: "2026-11-16", self_employed: false }, credit_refresh_open: true, compliance_disburse_open: true, ptf: { ptf_cleared: true }, cash_to_close: { worksheet: { reconciled_to_cd: true, sufficient: true } }, gifts: [{ gift_id: this.giftId, status: "transfer_verified" }], mi: { status: "docs_ready" }, wire: { verified_at: this.VERIFIED_WIRE.verified_at, blocks_disbursement: false, callback_number_source: "alta_registry", as_of },
    payoffs: [], first_payment: { first_payment_date: "2027-01-01" }, audit_trail_open: true, enote: { registered: true, secured_party_set: true }, qc_hold: false, commitment: { active: true, expires_on: this.commitmentExpiresOn || "2026-12-09" }, worksheet: { reconciled: true }, fraud: { fraud_hold: false, ofac_clear: true } });

  // ═══════════════ phases
  /** 20.4's global rows: the LLPA matrix 09.09.2026, SM's OH / purchase / traditional cost schedule ($2,774.00, the officer's approval), the Thu Oct 15 30-day sheet. */
  async seedPricing(): Promise<void> {
    this.at(EDT("2026-09-01", "12:00")); await this.tool({}, "20.4", "buildFeeItems", { op: "cost_schedule", cost_schedule_id: "cs-oh-purchase-traditional-2026-09", partner_id: this.PARTNER_ID, state: "OH", transaction_type: "purchase", valuation_method: "traditional", items: this.COST_ITEMS, effective_from: "2026-09-01" }, OFFICER);
    this.at(EDT("2026-09-10", "12:00")); await this.tool({}, "20.4", "loadLlpaTable", { op: "stage", matrix_version: "09.09.2026", activate: true }, PRICING);
    await this.publishSheet("2026-10-15");
  }
  /** The day's best-efforts sheet, published 06:35 ET (20.4; the 21.4 pricing port reads it) — once per day, at 06:35 or at the clock's later reading. */
  async publishSheet(date: string): Promise<void> {
    if (this.sheets.has(date)) return; this.sheets.add(date);
    this.at(ET(date, "06:35")); await this.tool({}, "20.4", "publishRateSheet", { rate_sheet_id: `rs-p-${date}`, partner_id: this.PARTNER_ID, source: "pe_whole_loan_api", published_at: ET(date, "06:35"), expires_at: ET(date, "17:00"), prices: this.PRICES }, PRICING);
  }
  /**
   * 20.3 worked example 2 (Thu Oct 15, 2026 11:05 ET): the organic visitor — "how much house can I afford?" — the disclosure, L1 by e-mail code, the
   * rule-6 facts (32.14 S1: Buy · Still looking · Ohio · price range $450,000 with $45,000 down), the soft-pull authorization and the report.
   * The lead lives on 20.3's aggregate (a global entity row); nothing names a property yet.
   */
  async openLead(): Promise<string> {
    const { leadId, R } = this; const scope = {};
    this.at(EDT("2026-10-15", "11:05"));
    await this.tool(scope, "20.3", "deliverDisclosure", { op: "create", lead_id: leadId, partner_id: this.PARTNER_ID, partner_name: this.PARTNER_NAME, channel: "organic", consumer_state: "OH", property_state: "OH", transaction_intent: "purchase", time_zone: "America/New_York" });
    await this.tool(scope, "20.3", "deliverDisclosure", { op: "start", lead_id: leadId, interaction_id: `i-p-${R}`, channel: "web_chat", ai: true });
    await this.tool(scope, "20.3", "deliverDisclosure", { lead_id: leadId, interaction_id: `i-p-${R}`, notice_id: `n-disc-p-${R}` });
    this.at(EDT("2026-10-15", "11:07")); await this.tool(scope, "20.3", "authenticate", { lead_id: leadId, method: "otp_email", evidence: { destination: this.o.borrowerEmail } });
    this.at(EDT("2026-10-15", "11:08"));
    for (const fact of [{ kind: "goal", transaction_intent: "purchase" }, { kind: "contract", contract_status: "looking" }, { kind: "state", consumer_state: "OH" }, { kind: "estimate", price_range_cents: "45000000", down_payment_cents: "4500000" }]) await this.tool(scope, "20.3", "explainProgram", { op: "set_fact", lead_id: leadId, fact });
    this.at(EDT("2026-10-15", "11:12")); await this.tool(scope, "20.3", "captureConsent", { lead_id: leadId, kind: "credit_authorization", authorization_id: `auth-p-${R}`, authorization_kind: "soft_prequal", text_version: "soft-prequal-2026-09", channel: "web_chat", end_user: "partner", evidence: { ip: "203.0.113.9", user_agent: "fixture", session_id: `i-p-${R}` } });
    await this.tool(scope, "20.3", "orderSoftPull", { lead_id: leadId });
    this.at(new Date("2026-10-15T11:12:30-04:00").toISOString()); await this.tool(scope, "20.3", "orderSoftPull", { lead_id: leadId, op: "receive", report_id: `rpt-p-${R}`, representative_score: 712 });
    return leadId;
  }
  /**
   * Mon Oct 19, 2026 18:40 EDT (21.1 worked example 2): the application opened over HTTP as the lead's id — purchase, primary, web, TWO borrowers
   * (B a non-permanent resident; no property: "still looking" → to be determined), the parties linked, then 20.3 converts the lead
   * (`application.received`: the Reg B clock REGB_1002_9_DECISION_30 runs from here; no TRID application yet — 32.3 T26 / 20.3 T5).
   */
  async openApplication(): Promise<string> {
    const { leadId } = this;
    this.at(EDT("2026-10-19", "18:40"));
    const r = await this.call("POST", "/v1/applications", { actor: INTAKE, application: {
      id: leadId, partner_party_id: this.o.partnerPartyId, channel: "organic", transaction_type: "purchase", occupancy: "primary", intake_channel: "web", interview_language: "en-US",
      borrowers: [{ legal_name: this.A, borrower_role: "borrower", citizenship_status: "us_citizen", language_preference: "en", tin_last4: "4120", date_of_birth: "1991-03-08", contact: { email: this.o.borrowerEmail } }, { legal_name: this.B, borrower_role: "co_borrower", citizenship_status: "non_permanent_resident", language_preference: "en", tin_last4: "8831", date_of_birth: "1992-07-21", contact: { email: this.o.coBorrowerEmail } }],
      property: null } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const app = r.body["application"] as { id: string; borrowers: { id: string }[] }; this.appId = app.id; this.abIds = app.borrowers.map((b) => b.id);
    if (this.o.linkParties) await this.o.linkParties(this.appId);
    this.at(EDT("2026-10-19", "18:41"));
    // application scope: the sign-in hook (32.3 E2/E4) already wrote the lead's later versions keyed by the application; a global-scope command would not see them
    const conv = await this.tool({ app: this.appId }, "20.3", "explainProgram", { op: "convert", lead_id: leadId, transaction_type: "purchase", occupancy: "primary", creditor_time_zone: "America/New_York", borrower_name: this.A });
    assert.equal(conv.output["application_id"], this.appId); assert.equal(conv.output["trid_application_date"], null, "no address yet: an application under Reg B, not TRID");
    return this.appId;
  }
  /**
   * 21.1 the interview, Mon Oct 19 18:41–20:31 EDT: the AI disclosure, the Reg B request (already `received` by the conversion), A's name, SSN and
   * income (five items minus the address and the amount), A's joint intent 18:52, B invited and added 20:15, B's joint intent 20:31
   * (SM_O21_JOINT_INTENT_GATE opens). The property stays to be determined: `property_address` is the item the contract will bring.
   */
  async interview(): Promise<void> {
    const scope = { app: this.appId }; const R = this.R;
    this.at(EDT("2026-10-19", "18:41"));
    await this.tool(scope, "21.1", "startInterview", { session_id: `S-P-${R}`, partner_name: this.PARTNER_NAME, partner_nmlsr_id: "123456", intake_channel: "web", creditor_time_zone: "America/New_York", property_state: "OH", transaction_type: "purchase", occupancy: "primary", borrowers: [{ id: "B1", legal_name: this.A, marital_status: "married" }, { id: "B2", legal_name: this.B, marital_status: "married" }], model_version: "intake-2026.09", prompt_version: "p-1.4" });
    this.at(new Date("2026-10-19T18:41:05-04:00").toISOString()); await this.tool(scope, "21.1", "discloseAI", { session_id: `S-P-${R}`, utterance_id: `utt-p-${R}`, state: "OH" });
    this.at(EDT("2026-10-19", "18:42")); await this.tool(scope, "21.1", "captureField", { field: "credit_request", transaction_type: "purchase", occupancy: "primary", property_state: "OH", identity_verified: true });
    this.at(EDT("2026-10-19", "18:45")); await this.tool(scope, "21.1", "captureField", { field: "name", value: this.A, borrower_id: "B1" });
    this.at(EDT("2026-10-19", "18:50")); await this.tool(scope, "21.1", "captureField", { field: "ssn", value: "123-45-4120", borrower_id: "B1" });
    this.at(EDT("2026-10-19", "18:52")); await this.tool(scope, "21.1", "affirmJointIntent", { borrower_id: "B1", method: "web_checkbox", evidence_id: `ji-a-${R}` });
    this.at(EDT("2026-10-19", "19:00")); await this.tool(scope, "21.1", "captureField", { field: "income", value: "820000", borrower_id: "B1" });
    // B joins by link at 20:15 (already on the intake record from the application's two borrower rows; her EAD to 2027-03-31 is 22.6's legal-presence item) and affirms joint intent at 20:31
    this.at(EDT("2026-10-19", "20:15")); await this.tool(scope, "21.1", "captureField", { field: "citizenship_status", value: "non_permanent_resident", borrower_id: "B2" });
    this.at(EDT("2026-10-19", "20:31")); const ji = await this.tool(scope, "21.1", "affirmJointIntent", { borrower_id: "B2", method: "web_checkbox", evidence_id: `ji-b-${R}` });
    assert.equal(ji.output["all_borrowers"], true);
  }
  /**
   * 32.3 C1, Mon Oct 19 20:32–20:44 EDT (after B's 20:31 joint intent): the signed contract arrives as a document (22.1 `ingestDocument{declared_class
   * purchase_contract}` → `classifyDocument` → `extractFields` by the FAKE extractor — the fields are the contract's own list) and the borrower confirms
   * the extraction through 32.2's `application.confirmField{path: purchase_contract}` (the `borrower-app` agent): `purchase_contracts` written, the
   * $457,800 price as the value item and 1187 Oakwood Ave as the fifth item (`purchase_contract.confirmed`); the $412,000 loan amount at 20:44 is the
   * sixth → `application.trid_received 2026-10-19 20:44 EDT`, LE due Thu Oct 22 (21.2 worked example 2b).
   *
   * NOTE (21.1 — gap 2): a confirmed extraction goes through 21.1 `confirmPrefill{value}` (32.2's `captureSix` for `source ≠ borrower`), which records
   * the six-item and its hash but — unlike `captureSixItem` / `offerPrefill` — does not stamp `property_address` / `property_state` on the intake
   * record; the item is submitted, the record's address stays null (the state was known from the lead).
   *
   * GAP 1 (subject property row): no origination tool writes `application_properties` for a to-be-determined purchase once the contract names the
   * address — 21.1 keeps the address on its six-item record and 32.2 writes `purchase_contracts`; the 32.14 lead flow inserts a state-only row and
   * `POST /v1/applications` takes a property only at creation. The record's Property pane and 3-entry's `isTbd` read `application_properties`, so
   * this application still reads as TBD downstream (24.1's "application_properties changes" trigger has nothing to react to).
   */
  async signContract(): Promise<void> {
    const scope = { app: this.appId }; const R = this.R; const doc = this.contractDocumentId;
    this.at(EDT("2026-10-19", "20:32"));
    await this.tool(scope, "22.1", "ingestDocument", { document_id: doc, source_channel: "borrower_upload", sha256: `sha-contract-${R}`, subject_borrower_id: "B1", applicant_borrower_ids: ["B1", "B2"], page_count: 14, declared_class: "purchase_contract" }, VERIFICATION);
    // 32.3 C1: when the flows share the runtime, 3-entry classifies the declared contract on `document.received` and tries the FAKE extraction from the uploaded bytes (none here — the bytes came over the bus); the fixture does whichever step the flow did not
    if (!(await this.has("document.classified", (p) => p["document_id"] === doc))) await this.tool(scope, "22.1", "classifyDocument", { document_id: doc, doc_class: "purchase_contract", borrower_declared: true, confidence: 1, classifier_version: "FAKE-contract-classifier-2026.09" }, VERIFICATION);
    this.at(EDT("2026-10-19", "20:33"));
    if (!(await this.has("document.extracted", (p) => p["document_id"] === doc))) await this.tool(scope, "22.1", "extractFields", { document_id: doc, fields: this.CONTRACT, extractor_version: "FAKE-contract-extractor-2026.09", ocr_engine: "FAKE", human_verified: false }, VERIFICATION);
    this.at(EDT("2026-10-19", "20:40"));
    const fields = Object.entries(this.CONTRACT).map(([path, v]) => ({ path, value: Array.isArray(v) ? v.join(", ") : String(v), source: "document_extraction" }));
    const confirmed = await this.tool(scope, "32.2", "application.confirmField", { application_id: this.appId, path: "purchase_contract", document_id: doc, borrower_id: "B1", application_borrower_id: this.abIds[0], lead_id: this.leadId, fields }, BORROWER_APP);
    assert.equal(confirmed.output["trid_emitted"], false, "the address is the fifth item; the loan amount is still missing");
    this.at(EDT("2026-10-19", "20:44")); const sixth = await this.tool(scope, "21.1", "captureField", { field: "loan_amount_sought", value: "41200000", borrower_id: "B1" });
    assert.equal(sixth.output["six_items_complete"], true); assert.equal(sixth.output["trid_emitted"], true);
  }
  /** 22.x, Mon Oct 19 20:50 → Tue Oct 20 09:05: IAL2 identity for both (B's second-method pass Oct 20), the OFAC screen, 21.4's credit-report fee (rule 1, before any LE), 22.2's tri-merge after the joint-intent gate (representative score 705 — the lower borrower's middle score). */
  async verifyAndOrderCredit(): Promise<string> {
    const scope = { app: this.appId }; const R = this.R;
    this.at(EDT("2026-10-19", "20:50")); await this.tool(scope, "22.6", "verifyIdentity", { borrower_id: "B1", borrower_ids: ["B1", "B2"], scheduled_note_date: "2026-11-18" }, FRAUD_RISK);
    this.at(EDT("2026-10-20", "09:00")); await this.tool(scope, "22.6", "verifyIdentity", { borrower_id: "B2", borrower_ids: ["B1", "B2"], scheduled_note_date: "2026-11-18" }, FRAUD_RISK);
    for (const [party, name] of [["B1", this.A], ["B2", this.B]] as const) await this.tool(scope, "22.6", "screenParty", { party_id: party, party_role: "borrower", name, lists: this.SDN_LISTS }, FRAUD_RISK);
    this.at(EDT("2026-10-20", "09:02")); await this.tool(scope, "21.4", "checkFeeGate", { command: "order_credit_report", fee_kind: "credit_report", amount_cents: "7500", vendor_invoice_cents: "6850", op: "impose", fee_item_id: `fee-credit-report-p-${R}`, method: "card_token", checked_at: EDT("2026-10-20", "09:02") }, PRICING);
    this.at(EDT("2026-10-20", "09:05"));
    const order = await this.tool(scope, "22.2", "orderCreditReport", { borrower_ids: ["B1", "B2"], permissible_purpose: "credit_transaction_604a3A", certification_ref: "CERT-PARTNER-1681E-2026", borrower_authorization_ref: `AUTH-HARD-${R}`, subscriber_code: "SUB-PARTNER-0417", joint_intent_facts: this.JOINT_INTENT, at: EDT("2026-10-20", "09:05") }, VERIFICATION);
    this.creditReportId = order.output["report_id"] as string;
    await this.tool(scope, "22.2", "parseCreditReport", { report_id: this.creditReportId }, VERIFICATION);
    return this.creditReportId;
  }
  /** 20.4 worked example B on the Tue Oct 20 sheet (09:10 EDT): HomeReady waiver → 6.375 %, P&I $2,570.34, lender credit $515.00. */
  async quote(): Promise<void> {
    await this.publishSheet("2026-10-20");
    this.at(EDT("2026-10-20", "09:10")); const q = await this.tool({ app: this.appId }, "20.4", "solvePassThrough", { inputs: this.QUOTE_INPUTS, quote_id: this.QUOTE, purpose: "lead_quote", partner_id: this.PARTNER_ID, lead_id: this.leadId }, PRICING);
    assert.equal(q.output["note_rate"], "0.06375", JSON.stringify(q.output).slice(0, 400)); assert.equal(q.output["pi_cents"], "257034"); assert.equal(q.output["lender_credit_cents"], "51500");
  }
  /**
   * 22.1 / 22.4, Tue Oct 20 10:30 → 11:00 (22.4 R1–R4, worked examples): the paystub; the statements (checking and savings Aug 1–31 and Sept 1–30 —
   * the two consecutive months a purchase needs, both dated after the Sept 4 floor of the Oct 19 application (22.4-T1); the 401(k)'s quarterly
   * statement); the cancelled EMD check (gap 5: ingested, not consumed); the declared assets (checking $31,240.18 / savings $14,900.00 / the vested
   * 401(k) $38,000.00 — R8 worked example 1); each account verified from its statements — the checking less the $5,000.00 `emd_offset` = $26,240.18
   * usable; R3 on the checking's $9,000.00 Sept 14 deposit ($6,500.00 printed as the brokerage transfer, $2,500.00 ≤ the $4,100.00 threshold → not
   * large, nothing withheld — 22.4-T3); the 401(k) `liquidation_required_for_closing` (reserves only, R6).
   */
  async declareAndVerifyAssets(): Promise<void> {
    const scope = { app: this.appId }; const R = this.R; const A = this.ASSET;
    this.at(EDT("2026-10-20", "10:30"));
    await this.document(`doc-pay-p-${R}`, "paystub", "B1");
    for (const [id, cls, pages] of [[`stmt-chk-aug-${R}`, "bank_statement", 4], [`stmt-chk-sep-${R}`, "bank_statement", 4], [`stmt-sav-aug-${R}`, "bank_statement", 2], [`stmt-sav-sep-${R}`, "bank_statement", 2], [`stmt-401k-q3-${R}`, "retirement_statement", 6], [`doc-emd-check-${R}`, "emd_evidence", 1]] as const) await this.document(id, cls, "B1", pages);
    await this.tool(scope, "22.4", "declareAssets", { assets: [
      { asset_id: A.checking, asset_type: "checking", borrower_ids: ["B1"], declared_balance_cents: "3124018", institution_name: "Huntington Bank", account_last4: "4477", holder_names: [this.A] },
      { asset_id: A.savings, asset_type: "savings", borrower_ids: ["B1", "B2"], declared_balance_cents: "1490000", institution_name: "Huntington Bank", account_last4: "4485", holder_names: [this.A, this.B] },
      { asset_id: A.retirement, asset_type: "retirement", borrower_ids: ["B1"], declared_balance_cents: "3800000", institution_name: "Fidelity", account_last4: "9012", holder_names: [this.A] }], borrower_names: [this.A, this.B] }, VERIFICATION);
    this.at(EDT("2026-10-20", "10:45"));
    const stmt = async (asset_id: string, document_id: string, period_start: string, period_end: string, ending_balance_cents: string, extra: Record<string, unknown> = {}) => {
      const r = await this.tool(scope, "22.4", "parseStatement", { asset_id, document_id, period_start, period_end, ending_balance_cents, initial_application_date: "2026-10-19", scheduled_note_date: "2026-11-18", ...extra }, VERIFICATION);
      return r.output as { status: string; usable_cents: string; gate: { open: boolean; required_count: number } | null };
    };
    await stmt(A.checking, `stmt-chk-aug-${R}`, "2026-08-01", "2026-08-31", "2841018", { emd_offset_cents: "500000" });
    const chk = await stmt(A.checking, `stmt-chk-sep-${R}`, "2026-09-01", "2026-09-30", "3124018", { emd_offset_cents: "500000" });
    assert.equal(chk.status, "verified", JSON.stringify(chk)); assert.equal(String(chk.usable_cents), "2624018", "checking $31,240.18 − the $5,000.00 EMD offset");
    await stmt(A.savings, `stmt-sav-aug-${R}`, "2026-08-01", "2026-08-31", "1490000");
    const sav = await stmt(A.savings, `stmt-sav-sep-${R}`, "2026-09-01", "2026-09-30", "1490000"); assert.equal(sav.status, "verified", JSON.stringify(sav));
    const ret = await stmt(A.retirement, `stmt-401k-q3-${R}`, "2026-07-01", "2026-09-30", "3800000", { quarterly: true }); assert.equal(ret.status, "verified", JSON.stringify(ret));
    this.at(EDT("2026-10-20", "11:00"));
    const dep = await this.tool(scope, "22.4", "evaluateDeposits", { asset_id: A.checking, total_monthly_qualifying_income_cents: "820000", deposits: [{ deposit_id: `dep-p-${R}`, posted_on: "2026-09-14", amount_cents: "900000", description_on_statement: "TRANSFER FROM SCHWAB …7781", sources: [{ cents: "650000", kind: "transfer_verified_account", readily_identifiable: true }] }] }, VERIFICATION);
    assert.equal(String(dep.output["threshold_cents"]), "410000"); assert.equal(String(dep.output["usable_cents"]), "2624018", "not a large deposit: nothing withheld");
  }
  /**
   * 24.6 worked example 1 (first half), Thu Oct 22 09:00 — before the LE that carries the plan: two insurers' quotes (standard 25 % at 0.38 %/yr and
   * the 12 % minimum at 0.30 % with its $1,545.00 LLPA), the borrower elects monthly BPMI at standard coverage → $130.47 (`mi_certificates{plan_selected}`;
   * LTV 89.99 → 90 %).
   */
  async miQuotesAndElection(): Promise<void> {
    const scope = { app: this.appId };
    this.at(EDT("2026-10-22", "09:00"));
    const quotes = await this.tool(scope, "24.6", "requestMiQuotes", { loan_amount_cents: "41200000", coverage_pct: 25, quotes: this.MI_QUOTES() }, CLOSER);
    assert.equal(quotes.output["multiple_insurers"], true);
    const std = (quotes.output["quotes"] as { quote_id: string; mi_company_code: string; coverage_option: string; monthly_premium_cents: string }[]).find((q) => q.mi_company_code === "06" && q.coverage_option === "standard")!;
    this.miQuoteId = std.quote_id; assert.equal(String(std.monthly_premium_cents), "13047");
    await this.tool(scope, "24.6", "compareMiPlans", { score_model: "classic_fico", representative_score: 705, loan_amount_cents: "41200000", ltv_pct_rounded: 90 }, CLOSER);
    this.at(EDT("2026-10-22", "09:10"));
    const elected = await this.tool(scope, "24.6", "recordPlanElection", { quote_id: this.miQuoteId, units: 1, occupancy: "primary", transaction_type: "purchase", loan_amount_cents: "41200000", sales_price_cents: "45780000", appraised_value_cents: "45780000", product: "fixed", term_months: 360, homeready: true, election: { by: "borrower", recorded_at: EDT("2026-10-22", "09:10") } }, CLOSER);
    const cert = elected.output["certificate"] as { certificate_id: string; coverage_pct: number; base_ltv_pct_rounded: number }; this.miCertificateId = cert.certificate_id; assert.equal(cert.coverage_pct, 25); assert.equal(cert.base_ltv_pct_rounded, 90);
  }
  /** 21.2's H-24 rendered Thu Oct 22 10:00 EDT (with the $130.47 BPMI) — a caller that delivers the LE its own way stops here. */
  async renderLe(): Promise<void> {
    this.at(EDT("2026-10-22", "10:00")); const h24 = await this.tool({ app: this.appId }, "21.2", "renderH24", this.LE_RENDER(), DISCLOSURE); this.leDataHash = h24.output["data_hash"] as string;
  }
  /** The H-24 and the LE delivered Thu Oct 22 10:00 EDT through the runtime's 21.2 bridge (MLO-approved; e-signed 12:30 → effective receipt Oct 22, inside the Thu Oct 22 deadline). */
  async deliverLe(): Promise<void> {
    await this.renderLe(); const R = this.R;
    this.at(EDT("2026-10-22", "12:30"));   // the bridge records the 10:00 delivery and the 12:30 e-signature in one call — made once the receipt is in
    const le = await this.call("POST", `/v1/applications/${this.appId}/disclosures/le`, { actor: MLO, render: this.LE_RENDER(), mlo: { review_id: `MR-LE-P-${R}`, nmlsr_id: "987654" }, delivery: { channel: "esign_portal", at: EDT("2026-10-22", "10:00"), consent: this.ESIGN_CONSENT, receipt: { kind: "esignature", at: EDT("2026-10-22", "12:30"), borrower_id: "B1" } } });
    assert.equal(le.status, 200, JSON.stringify(le.body)); assert.equal(le.body["status"], "received"); assert.equal(le.body["le_due_on"], "2026-10-22");
  }
  /** The quote and the LE in one step (a caller without the assets and MI phases between them). */
  async quoteAndLe(): Promise<void> { await this.quote(); await this.deliverLe(); }
  /** 21.4 worked example 3: intent Fri Oct 23 09:14 EDT. */
  async recordIntent(): Promise<void> {
    this.at(EDT("2026-10-23", "09:14"));
    const intent = await this.tool({ app: this.appId }, "21.4", "recordIntent", { channel: "app_button", statement_text: "I want to proceed with this Loan Estimate", evidence_document_id: `evt-app-tap-p-${this.R}`, received_at: EDT("2026-10-23", "09:14") }, PRICING);
    assert.equal(intent.output["valid"], true);
  }
  /**
   * 24.1 (24 README INT-O5-3; discrepancy a): no DU offer yet → traditional URAR (UAD 3.6) ordered Fri Oct 23 09:30 EDT with the AMC under the SM-borne
   * $650.00 fee (inside the Franklin County band) after the 09:14 intent (24.1 R2), the appraiser assigned the same day (SM_APPRAISER_LICENSE_GATE),
   * the inspection scheduled for Tue Oct 27. The order is placed before DU's findings land (gap 3).
   */
  async appraisalOrder(): Promise<void> {
    const scope = { app: this.appId };
    this.at(EDT("2026-10-23", "09:30"));
    const offer = await this.tool(scope, "24.1", "readDuOffer", {}, VALUATION); assert.equal(offer.output["offer_type"], "none");
    const vo = await this.tool(scope, "24.1", "placeOrder", { transaction_type: "purchase", occupancy: "primary", units: 1, property_type: "sfr", ltv_bps: 8999, fee_paid_by: "sm", fee_quote_cents: "65000", fee_test: this.FEE_TEST, property_state: "OH", vendor_party_id: "amc-1", channel: "amc", amc_registration: this.AMC_REG, order_payload: this.ORDER_PAYLOAD, ordered_at: EDT("2026-10-23", "09:30"), time_zone: "America/New_York" }, VALUATION);
    this.valuationOrderId = vo.output["order_id"] as string; assert.equal(vo.output["method"], "traditional");
    this.at(EDT("2026-10-23", "10:00")); const assigned = await this.tool(scope, "24.1", "verifyAppraiserLicense", { order_id: this.valuationOrderId, appraiser: this.APPRAISER, property_state: "OH", assigned_at: EDT("2026-10-23", "10:00") }, VALUATION);
    assert.equal(assigned.output["status"], "assigned", JSON.stringify(assigned.output));
    this.at(EDT("2026-10-23", "10:30")); await this.tool(scope, "24.1", "scheduleInspection", { order_id: this.valuationOrderId, scheduled_at: EDT("2026-10-23", "10:30"), scheduled_for: EDT("2026-10-27", "10:00") }, VALUATION);
  }
  /**
   * 24.1 / 24.2: the inspection completed Tue Oct 27 12:00, the report Thu Oct 29 at $460,000 (effective Oct 27) → 24.2 ingests it, submits to UCDP
   * (both GSEs successful, CU 1.9) and reviews it: accepted, `value_used = lower_of_two` = $457,800.00, the Reg B copy package built and e-delivered
   * Fri Oct 30 (≥ 3 business days before Nov 18).
   */
  async appraisalReceipt(): Promise<void> {
    const scope = { app: this.appId }; const R = this.R;
    this.at(EDT("2026-10-27", "12:00")); await this.tool(scope, "24.1", "scheduleInspection", { op: "complete", order_id: this.valuationOrderId, completed_at: EDT("2026-10-27", "12:00") }, VALUATION);
    this.at(EDT("2026-10-29", "14:20"));
    const rcv = await this.tool(scope, "24.1", "trackOrder", { op: "receive", order_id: this.valuationOrderId, report_document_id: `doc-appraisal-p-${R}`, uad_version: "3.6", effective_date: "2026-10-27", received_at: EDT("2026-10-29", "14:20"), lender_client_name: this.PARTNER_NAME, partner_name: this.PARTNER_NAME, fee_invoice_cents: "65000" }, VALUATION);
    assert.equal(rcv.output["accepted"], true, JSON.stringify(rcv.output).slice(0, 400));
    this.appraisalId = `APR-P-${R}`;
    const ingested = await this.tool(scope, "24.2", "ingestReport", { appraisal_id: this.appraisalId, version_no: 1, package: this.PACKAGE, appraised_value_cents: "46000000", effective_date: "2026-10-27", appraiser_party_id: this.APPRAISER.party_id, valuation_order_id: this.valuationOrderId, received_at: EDT("2026-10-29", "14:20"), pdf_document_id: `doc-appraisal-p-${R}` }, VALUATION);
    assert.equal((ingested.output["precheck"] as { ok: boolean }).ok, true, JSON.stringify(ingested.output["precheck"]));
    // R2: UCDP (both GSEs; the FAKE answers successful, CU 1.9 → no ROV, the standard review tier) within SM_UCDP_SUBMIT_SLA_1BD
    this.at(EDT("2026-10-29", "15:05")); await this.tool(scope, "24.2", "submitUcdp", { appraisal_id: this.appraisalId, version_no: 1, package_hash: `sha256:appraisal-p-${R}-v1` }, VALUATION);
    this.at(EDT("2026-10-29", "15:07")); const polled = await this.tool(scope, "24.2", "pollFindings", { appraisal_id: this.appraisalId, version_no: 1 }, VALUATION);
    assert.equal((polled.output["routing"] as { route: string }).route, "successful", JSON.stringify(polled.output["routing"])); assert.equal((polled.output["cu"] as { cu_score: number }).cu_score, 1.9);
    this.at(EDT("2026-10-29", "16:00"));
    const review = await this.tool(scope, "24.2", "applyReviewChecklist", { appraisal_id: this.appraisalId, version_no: 1, checklist: this.CHECKLIST, transaction_type: "purchase", purchase_price_cents: "45780000", loan_amount_cents: "41200000", consummation_on: "2026-11-18", reviewed_at: EDT("2026-10-29", "16:00") }, VALUATION);
    assert.equal(review.output["review_status"], "accepted", JSON.stringify(review.output).slice(0, 600));
    const vu = review.output["value_used"] as { value_used_cents: string; value_basis: string }; assert.equal(vu.value_basis, "lower_of_two"); assert.equal(String(vu.value_used_cents), "45780000");
    this.at(EDT("2026-10-30", "09:00"));
    const pkg = await this.tool(scope, "24.2", "buildCopyPackage", { completion_at: review.output["completion_at"], consummation_on: "2026-11-18", esign_consent_covers_disclosures: true, first_version: true }, VALUATION);
    const pkgValuations = (pkg.output["valuations"] as { valuation_id: string; kind?: string; developed_at?: string; version_no?: number }[] | undefined) ?? [];
    const valuationIds = pkgValuations.map((v) => v.valuation_id);
    // NTC_REGB_1002_14_VALUATION_COPY's "all-valuations" rule (12 CFR 1002.14(a)(1); (b)(3)) lists every enclosed valuation with its developed date (the same payload shape 24.2's own T-tests use).
    const listed = pkgValuations.length ? pkgValuations.map((v) => ({ kind_label: v.kind === "appraisal" || v.kind === undefined ? "Uniform Residential Appraisal Report (Form 1004, UAD 3.6)" : String(v.kind).replace(/_/g, " "), developed_at: (v.developed_at ?? "2026-10-29").slice(0, 10), version_no: v.version_no ?? 1 })) : [{ kind_label: "Uniform Residential Appraisal Report (Form 1004, UAD 3.6)", developed_at: "2026-10-29", version_no: 1 }];
    await this.tool(scope, "24.2", "deliverNotice", { template_code: "NTC_REGB_1002_14_VALUATION_COPY", version: 1, channel: "electronic", esign_consent_verified: true, appraisal_id: this.appraisalId, is_final_version: true, hpml: false, valuation_ids: valuationIds, delivered_at: EDT("2026-10-30", "09:00"), receipt_evidence: "esign_confirmed", consummation_on: "2026-11-18",
      recipients: [{ partyId: "B1", name: this.A, mailingAddress: this.ADDRESS, email: this.o.borrowerEmail, portalUser: true }, { partyId: "B2", name: this.B, mailingAddress: this.ADDRESS, email: this.o.coBorrowerEmail, portalUser: true }],
      payload: { partner_name: "Partner Bank, N.A.", borrower_names: [this.A, this.B], property_address: this.ADDRESS, loan_number_last4: this.appId.slice(-4), mlo_name: "Ada Okonkwo", mlo_nmlsr_id: "987654", contact_phone: "1-800-555-0155", notice_date: "2026-10-30", completion_at: "2026-10-29", earliest_consummation: "2026-11-04", consummation_scheduled_on: "2026-11-18", revision: false, includes_rov_disclosure: true, valuation_count: listed.length, valuations: listed } }, VALUATION);
  }
  /** 23.1 DU (casefile → credit association → request → submission → findings Approve/Eligible) and 23.2's interpretation 12 minutes later (SM_DU_CONDITIONS_SLA_4H) — Mon Oct 26 09:00 EDT here, after the appraisal order (gap 3); 28.1 worked example 2 has it Tue Oct 20. */
  async duSubmitAndInterpret(times: { findings_at: string; interpreted_at: string } = { findings_at: EDT("2026-10-26", "09:00"), interpreted_at: EDT("2026-10-26", "09:12") }): Promise<{ submission_id: string; interpretation_id: string | null; request_hash: string; conditions: string[] }> {
    const scope = { app: this.appId }; const clock = this.clock;
    this.at(times.findings_at);
    const cf0 = createCasefile(new MemoryEventStore(clock), { application_id: this.appId, seller_number: "123456789", system_id_ref: "SYS-PARTNER-01", tsp_product_ref: "SM-TSP", score_model: "classic_fico", created_at: clock.now() }).casefile; this.casefileId = cf0.casefile_id;
    const report = await this.entity("credit_reports", this.creditReportId);
    await this.tool(scope, "23.1", "associateCredit", { casefile: cf0, reports: [report], borrowers: this.BORROWER_IDENTITIES, app_score_model: "classic_fico" }, UNDERWRITER);
    const built = await this.tool(scope, "23.1", "buildDuRequest", { casefile_id: this.casefileId, submission_type: "credit_and_underwriting", reason: "initial", snapshot: this.ULAD() }, UNDERWRITER);
    await this.tool(scope, "23.1", "submitCasefile", { casefile_id: this.casefileId, request: built.output["request"], projected_note_date: "2026-11-18", scif_facts: { borrowers: this.BORROWER_IDENTITIES.map((b) => ({ id: b.borrower_id, scif_presented_at: EDT("2026-10-19", "18:47") })) } }, UNDERWRITER);
    const findings = await this.tool(scope, "23.1", "fetchFindings", { casefile_id: this.casefileId, submission_number: 1 }, UNDERWRITER);
    const submission = findings.output["submission"] as Record<string, unknown>;
    this.at(times.interpreted_at);
    const interp = await this.tool(scope, "23.2", "parseFindings", { op: "interpret", submission_id: submission["submission_id"], submission_number: 1, recommendation: "approve_eligible", messages: this.DU_MESSAGES, validation_results: [], value_acceptance_offer: { offered: false }, mi_requirement: { required: true, coverage_pct: "25" }, du_release: "2026-09-25", policy_generation: "2026_09_26", request_hash: built.output["request_hash"], findings_received_at: times.findings_at, facts: this.DU_FACTS }, UNDERWRITER);
    return { submission_id: String(submission["submission_id"]), interpretation_id: ((interp.output["interpretation"] as { interpretation_id?: string } | undefined)?.interpretation_id) ?? null, request_hash: String(built.output["request_hash"]), conditions: (interp.output["conditions"] as string[] | undefined) ?? [] };
  }
  /** Mon Oct 26: the day's sheet and 21.4's quote at 10:05 EDT (the lock's basis, 30 days). */
  async quoteForLock(): Promise<string> {
    await this.publishSheet("2026-10-26"); this.at(EDT("2026-10-26", "10:05"));
    const quote = await this.tool({ app: this.appId }, "21.4", "getQuote", { loan_amount_cents: "41200000", product_code: "FRM30_CONV", note_rate_pct: "6.375", lock_period_days: 30, price_pct: "101.000", at: EDT("2026-10-26", "10:05") }, PRICING);
    this.quoteId = quote.output["quote_id"] as string; return this.quoteId;
  }
  async requestLock(): Promise<string> {
    const req = await this.tool({ app: this.appId }, "21.4", "requestLock", { quote_id: this.quoteId, borrower_statement: "Please lock my rate today", property_state: "OH", le_loan_amount_cents: "41200000", requested_at: EDT("2026-10-26", "10:05") }, PRICING);
    this.lockId = req.output["lock_id"] as string; assert.equal(req.output["status"], "pending_mlo_approval"); return this.lockId;
  }
  /** The MLO approves 10:19 EDT, the lock executes at 6.375 % for 30 days → expires Wed Nov 25, 2026 (21.4 worked example 3: a creditor business day, no roll); 29.1 takes the commitment. */
  async executeLockAndCommit(): Promise<void> {
    const scope = { app: this.appId }; this.at(EDT("2026-10-26", "10:19"));
    await this.tool(scope, "21.4", "executeLock", { lock_id: this.lockId, op: "approve", quote_id: this.quoteId, mlo_nmlsr_id: "987654", approved_at: EDT("2026-10-26", "10:19") }, MLO);
    const lock = await this.tool(scope, "21.4", "executeLock", { lock_id: this.lockId, executed_at: EDT("2026-10-26", "10:19") }, PRICING);
    assert.equal(lock.output["status"], "executed"); assert.equal(lock.output["expires_on"], "2026-11-25");
    this.at(EDT("2026-10-26", "10:20")); const c = await this.tool(scope, "21.4", "requestCommitment", { lock_id: this.lockId, at: EDT("2026-10-26", "10:20") }, PRICING); this.commitmentId = c.output["commitment_id"] as string; this.commitmentExpiresOn = String(c.output["expires_on"] ?? "");
  }
  /** 23.3 Mon Oct 26 11:00 EDT: the comprehensive risk assessment and the conditional approval (valid until Wed Nov 25 — the lock is the earliest expiring component). */
  async conditionalApproval(du: { submission_id: string; interpretation_id: string | null; request_hash: string }): Promise<void> {
    const scope = { app: this.appId }; this.at(EDT("2026-10-26", "11:00"));
    await this.tool(scope, "23.3", "assessRisk", { risk_input: this.RISK, decision_id: this.decisionId }, UNDERWRITER);
    const file = newDecisionFile({ application_id: this.appId, partner_name: this.PARTNER_NAME, partner_address: "100 Partner Plaza, Phoenix, AZ 85004", creditor_time_zone: "America/New_York", application_date: "2026-10-19", property_state: "OH", applicants: [{ id: "B1", name: this.A, mailing_address: "410 E Whittier St, Columbus OH 43206", email: this.o.borrowerEmail, esign_consent: true, primary: true }, { id: "B2", name: this.B, mailing_address: "410 E Whittier St, Columbus OH 43206", email: this.o.coBorrowerEmail, esign_consent: true, primary: false }] });
    const approval = await this.tool(scope, "23.3", "issueConditionalApproval", { decision_id: this.decisionId, file, guard: this.GUARD, validity: this.VALIDITY, inputs: { ulad_snapshot_hash: du.request_hash, verification_ids: ["ver-inc-p-1"], findings_hash: "findings:sub1" }, du_submission_id: du.submission_id, interpretation_id: du.interpretation_id, evidence_document_ids: [`doc-pay-p-${this.R}`, this.contractDocumentId], rationale: "Approve/Eligible HomeReady purchase within policy; verified income, assets (incl. the sourced deposit and the gift) and liabilities reconcile to DU; LTV 90 % with BPMI standard coverage.", confidence: 0.93 }, UNDERWRITER);
    assert.equal(approval.output["valid_until"], "2026-11-25");
  }
  /** 24.6 worked example 1 (second half, first part): the delegated order Mon Oct 26 11:30 (DU Approve/Eligible), the commitment Tue Oct 27 09:00 with the certificate number. */
  async miOrderAndCommitment(): Promise<void> {
    const scope = { app: this.appId }; const R = this.R;
    this.at(EDT("2026-10-26", "11:30")); await this.tool(scope, "24.6", "submitMiOrder", { order_type: "delegated", du_reliance: true, du_casefile_id: this.casefileId, du_recommendation: "Approve/Eligible" }, CLOSER);
    this.at(EDT("2026-10-27", "09:00")); this.miCertificateNumber = `MGIC-${R}`;
    const committed = await this.tool(scope, "24.6", "parseCommitment", { response: { decision: "commitment", commitment_number: `MGIC-C-${R}`, certificate_number: this.miCertificateNumber, coverage_pct: 25, premium_plan: "bpmi_monthly", rate_bps: 38, renewal_type: "constant", refundable: false, issued_at: EDT("2026-10-27", "09:00"), expires_at: EDT("2027-02-27", "23:59"), insurer_code: "06", master_policy_version: "MGIC-MP-2024" } }, CLOSER);
    assert.equal((committed.output["certificate"] as { status: string }).status, "committed");
  }
  /**
   * 24.6 worked example 1 (second half, continued), Fri Oct 30 10:00: the initial amortization schedule from the final note terms (P&I $2,570.34), the
   * HPA dates (cancellation Oct 1, 2034 / termination Dec 1, 2035 / midpoint Jan 1, 2042), the terms verification and the §4903 initial disclosure → `docs_ready`.
   */
  async miScheduleAndDisclosure(): Promise<{ cancellation_date: string; termination_date: string; midpoint_termination_date: string; pi_cents: string }> {
    const scope = { app: this.appId };
    this.at(EDT("2026-10-30", "10:00"));
    const sched = await this.tool(scope, "24.6", "buildInitialAmortizationSchedule", { note_amount_cents: "41200000", note_rate_pct: "6.375", term_months: 360, first_payment_due: "2027-01-01", monthly_premium_cents: "13047", original_value_cents: "45780000" }, CLOSER);
    const dates = await this.tool(scope, "24.6", "computeHpaDates", { original_value_cents: "45780000" }, CLOSER);
    const verified = await this.tool(scope, "24.6", "verifyCertificateMatchesTerms", { loan_amount_cents: "41200000", value_basis_cents: "45780000", product: "fixed", term_months: 360, homeready: true, premium_plan_on_cd: "bpmi_monthly", note_date: "2026-11-18" }, CLOSER);
    assert.equal(verified.output["matches"], true, JSON.stringify(verified.output["mismatches"]));
    const hpa = await this.tool(scope, "24.6", "renderHpaDisclosure", { product: "fixed", partner_name: this.PARTNER_NAME, borrower_name: this.A, property_address: this.ADDRESS, loan_number: this.appId.slice(0, 8) }, CLOSER);
    assert.equal(hpa.output["rendered"], true, JSON.stringify(hpa.output)); assert.equal(hpa.output["status"], "docs_ready");
    return { cancellation_date: String(dates.output["cancellation_date"]), termination_date: String(dates.output["termination_date"]), midpoint_termination_date: String(dates.output["midpoint_termination_date"]), pi_cents: String(sched.output["pi_cents"]) };
  }
  /**
   * 22.4 (R5, R7, R8 — worked examples), Fri Oct 30 11:00 → 11:30: the $10,000.00 gift from Borrower A's mother (the letter states the maximum and "no
   * repayment is expected", donor name / address / phone; the donor is no party to the sale), wired Mon Oct 26 and evidenced by the donor's wire
   * confirmation and the October statement line → `transfer_verified` (FNMA_B3_4_3_04_GIFT_TRANSFER_GATE); the seller's $5,000.00 credit recorded
   * as the IPC of record and R7's limit test on the appraised $460,000 (base $457,800 → 6 % at 90 % CLTV = $27,468.00 ≥ $5,000.00); then the
   * funds-to-close worksheet (pre-CD) from the VERIFIED rows — checking $26,240.18 + savings $14,900.00 + gift $10,000.00 = $51,140.18 ≥ $43,997.00,
   * reserves 51,140.18 − 43,997.00 + 38,000.00 = $45,143.18 ≥ $8,000.00 → sufficient. The EMD ($5,000.00) and the seller credit are two different
   * $5,000.00s: the borrower's deposit with the title agency, and the seller's concession.
   */
  async giftAndFundsToClose(): Promise<Record<string, unknown>> {
    const scope = { app: this.appId }; const R = this.R; const A = this.ASSET;
    this.at(EDT("2026-10-30", "11:00"));
    for (const [id, cls] of [[`doc-gift-letter-${R}`, "gift_letter"], [`doc-gift-wire-${R}`, "gift_transfer_evidence"], [`stmt-chk-oct-${R}`, "bank_statement"]] as const) await this.document(id, cls, "B1", 1);
    await this.tool(scope, "22.4", "declareAssets", { assets: [{ asset_id: A.gift, asset_type: "gift", borrower_ids: ["B1"], declared_balance_cents: "1000000" }], borrower_names: [this.A, this.B] }, VERIFICATION);
    this.giftId = `gift-p-${R}`;
    const letter = await this.tool(scope, "22.4", "verifyGift", { gift_id: this.giftId, asset_id: A.gift, borrower_id: "B1", letter_document_id: `doc-gift-letter-${R}`, donor_name: this.DONOR, donor_address: "88 Neil Ave, Columbus OH 43215", donor_phone: "614-555-0100", relationship: "parent", amount_stated_cents: "1000000", amount_is_maximum: true, no_repayment_statement: true, parties: [{ name: this.SELLER, role: "seller" }, { name: "Buckeye Title Agency LLC", role: "settlement_agent" }] }, VERIFICATION);
    assert.equal(letter.output["complete"], true, JSON.stringify(letter.output).slice(0, 400));
    this.at(EDT("2026-10-30", "11:10"));
    const wired = await this.tool(scope, "22.4", "verifyGift", { op: "transfer", gift_id: this.giftId, evidence_kind: "electronic_transfer", transfer_amount_cents: "1000000", evidence_document_ids: [`doc-gift-wire-${R}`, `stmt-chk-oct-${R}`], transferred_on: "2026-10-26" }, VERIFICATION);
    assert.equal(wired.output["status"], "transfer_verified"); assert.equal(wired.output["gate_open"], true);
    this.at(EDT("2026-10-30", "11:20"));
    await this.tool(scope, "22.4", "recordIpc", { ipc_id: `ipc-seller-p-${R}`, payer_role: "seller", kind: "financing_concession", amount_cents: "500000", disclosed_on_settlement: true, evidence_document_ids: [this.contractDocumentId] }, VERIFICATION);
    const ipc = await this.tool(scope, "22.4", "testIpcLimits", { sales_price_cents: "45780000", appraised_value_cents: "46000000", loan_amount_cents: "41200000", occupancy: "primary" }, VERIFICATION);
    assert.equal(ipc.output["ok"], true, JSON.stringify(ipc.output).slice(0, 400));
    this.at(EDT("2026-10-30", "11:30"));
    this.worksheetId = `ws-p-${R}`;
    const ws = await this.tool(scope, "22.4", "buildFundsToCloseWorksheet", { worksheet_id: this.worksheetId, stage: "pre_cd", transaction: "purchase", sales_price_cents: "45780000", appraised_value_cents: "46000000", loan_amount_cents: "41200000", total_closing_costs_cents: "871200", down_payment_cents: "4580000", emd_cents: "500000", seller_credits_cents: "500000", lender_credit_premium_cents: "51500", reserves_required_cents: "800000" }, VERIFICATION);
    this.worksheet = ws.output; return ws.output;
  }
  /** 24.4 (24 README INT-O5-3), Mon Nov 2 09:00: the settlement agent vetted (license, E&O, fidelity, the ALTA Registry id, the underwriter's confirmation) and the commitment ordered on the 2021 ALTA form. */
  async titleOrder(): Promise<void> {
    const scope = { app: this.appId };
    this.at(EST("2026-11-02", "09:00"));
    const vet = await this.tool(scope, "24.4", "vetSettlementAgent", { party_id: this.AGENT_PARTY, agent_type: "title_agency", state: "OH", property_state: "OH", license_active: true, license_number: "OH-TA-2210", eo_policy_limit_cents: "200000000", eo_expires_on: "2027-06-30", fidelity_limit_cents: "100000000", alta_registry_id: "ALTA-OH-77120", underwriter_confirmed_by: this.UNDERWRITER_PARTY, best_practices_attestation_at: "2026-08-15", wire_instructions_on_letterhead: true, cpl_available: true, underwriter_callback_number_verified: true, referral_consideration: false, at: EST("2026-11-02", "09:00") }, CLOSER);
    assert.equal(vet.output["vetting_status"], "approved", JSON.stringify(vet.output).slice(0, 400));
    this.at(EST("2026-11-02", "09:05"));
    const ordered = await this.tool(scope, "24.4", "orderTitle", { settlement_agent_party_id: this.AGENT_PARTY, underwriter_party_id: this.UNDERWRITER_PARTY, apn: this.APN, note_amount_cents: "41200000", proposed_insured_text: `${this.PARTNER_NAME}, its successors and/or assigns`, closing_date: "2026-11-18", property: { state: "OH" }, at: EST("2026-11-02", "09:05") }, CLOSER);
    this.titleOrderId = (ordered.output["order"] as { id: string }).id;
  }
  /** 23.3 Fri Nov 6 15:00 EST (28.1 worked example 2: PTD cleared Fri Nov 6): the CTC checklist and clear to close. */
  async clearToClose(): Promise<void> {
    const scope = { app: this.appId }; this.at(EST("2026-11-06", "15:00"));
    const checklist = await this.tool(scope, "23.3", "runCtcChecklist", { op: "ctc", decision_id: this.decisionId, facts: this.CTC_FACTS() }, UNDERWRITER);
    assert.equal(checklist.output["passed"], true, JSON.stringify(checklist.output).slice(0, 600));
    const ctc = await this.tool(scope, "23.3", "issueClearToClose", { decision_id: this.decisionId, checklist: checklist.output }, UNDERWRITER);
    assert.equal(ctc.output["event"], "clear_to_close.issued");
  }
  /** 26.2 Mon Nov 9 10:00 EST: the RON closing scheduled Wed Nov 18 10:05 EST (Ohio: fnma_listed, R.C. 147.64–147.65; wet state → `dry_state: false`; a purchase is not rescindable). */
  async scheduleClosing(): Promise<void> {
    this.at(EST("2026-11-09", "10:00"));
    const sch = await this.tool({ app: this.appId }, "26.2", "runPreSessionChecks", { op: "schedule", closing_id: this.CLOSING_ID, application_id: this.appId, scheduled_at: EST("2026-11-18", "10:05"), time_zone: "America/New_York", state: "OH", county_fips: "39049", transaction_type: "purchase", rescindable: false, dry_state: false, settlement_agent_party_id: this.AGENT_PARTY, notary_party_id: this.NOTARY.party_id, ron_provider_party_id: "P-RON-1", eligibility: this.ELIGIBILITY, signers: this.SIGNERS }, CLOSER);
    assert.equal(sch.output["closing_type"], "ron", JSON.stringify(sch.output["reasons"]));
  }
  /** 24.4 Tue Nov 10 10:00: the commitment received (2021 ALTA Loan Policy, ALTA 8.1 committed, the seller-side judgments cleared, no blocking exceptions → `reviewed`) and the settlement agent's wire instructions verified (vendor match + ALTA Registry callback). */
  async titleCommitmentAndWire(): Promise<void> {
    const scope = { app: this.appId }; const R = this.R;
    this.at(EST("2026-11-10", "10:00"));
    const commitment = await this.tool(scope, "24.4", "parseCommitment", { order_id: this.titleOrderId, commitment_number: `CMT-OH-${R}`, commitment_effective_date: "2026-11-09", underwriter_party_id: this.UNDERWRITER_PARTY, underwriter_state: "OH", doi_licensed: true, strength_basis: "rating", policy_form: "ALTA Loan Policy (07-01-2021)", policy_amount_cents: "41200000", legal_description: this.LEGAL, apn: this.APN, vesting: { names: [this.A, this.B], tenancy: "joint_tenants", trust: false, estate: "fee_simple" }, schedule_b1_requirements: [`Deed from ${this.SELLER} to the insured borrowers, recorded`], schedule_b2_exceptions: [], endorsements_committed: ["ALTA 8.1-06"], property: { state: "OH" }, appraisal_legal_description: this.LEGAL, at: EST("2026-11-10", "10:00") }, CLOSER);
    assert.equal(commitment.output["accepted"], true, JSON.stringify(commitment.output).slice(0, 400)); assert.equal(commitment.output["status"], "reviewed", JSON.stringify(commitment.output["curative_opened"]));
    const wire = await this.tool(scope, "24.4", "verifyWireInstructions", { purpose: "closing_funds", beneficiary_party_id: this.AGENT_PARTY, routing_number: "044000024", account_number: "3300771249", instructions_channel: "portal", vendor: "fundingshield", vendor_match: "verified", vendor_ref: "FS-77120", callback: { completed: true, number_source: "alta_registry" }, funding_at: EST("2026-11-18", "08:00"), at: this.VERIFIED_WIRE.verified_at }, CLOSER);
    assert.equal((wire.output["verification"] as { blocks_disbursement: boolean }).blocks_disbursement, false, JSON.stringify(wire.output).slice(0, 400));
  }
  /**
   * 25.2 worked example 4: the settlement agent's figures due Thu Nov 12 (SM_O62_SETTLEMENT_FIGURES_5SBD) — recorded and reconciled with the escrow
   * source; 25.1's Appendix J APR; CD v1 rendered Thu Nov 12, e-delivered to both consumers Fri Nov 13 (SM_O62_CD_TARGET_4SBD) with e-sign receipts
   * the same day → `earliest_consummation_date = 2026-11-17` (Sat 14, Mon 16, Tue 17); then 22.4 R8's reconciliation of the worksheet to the CD's
   * "Cash to Close $43,997.00" (SM_CASH_TO_CLOSE_RECONCILED_GATE). `deliveries: false` stops after `renderCd`.
   */
  async closingDisclosure(opts: { receipts?: boolean; deliveries?: boolean } = {}): Promise<string> {
    const scope = { app: this.appId }; const R = this.R;
    this.at(EST("2026-11-12", "10:00"));
    await this.tool(scope, "25.2", "assembleCdFigures", { op: "record_source", source_id: `SRC-SA-P-${R}`, party: "settlement_agent", payload: { fees: [{ fee_code: "title_lender_policy", amount_cents: "139500" }, { fee_code: "settlement_fee", amount_cents: "55000" }, { fee_code: "title_endorsements", amount_cents: "12500" }, { fee_code: "recording", amount_cents: "15000" }, { fee_code: "owners_title_policy", amount_cents: "206652" }] }, payload_document_id: "DOC-SA-FEES-P" }, DISCLOSURE);
    await this.tool(scope, "25.2", "assembleCdFigures", { op: "record_source", source_id: `SRC-ESCROW-P-${R}`, party: "escrow", payload: { monthly_cents: "61500", deposit_cents: "124000" } }, DISCLOSURE);
    const rec = await this.tool(scope, "25.2", "reconcileFigureSources", { fees: this.CD_FEES() }, DISCLOSURE);
    assert.ok((rec.output as unknown as { reconciled: boolean }[]).every((s) => s.reconciled), JSON.stringify(rec.output).slice(0, 400));
    const apr = await this.tool(scope, "25.1", "computeApr", { loan_amount_cents: "41200000", note_rate_pct: "6.375", term_months: 360, term_start_date: "2026-11-18", first_payment_date: "2027-01-01", prepaid_finance_charges_cents: "106848", prepaid_interest_cents: "93548", checkpoint: "cd" }, COMPLIANCE);
    this.cdDisclosureId = `CD-${this.appId.slice(0, 8)}-1`;
    await this.tool(scope, "25.2", "renderCd", { disclosure_id: this.cdDisclosureId, cd_version: 1, transaction_type: "purchase", state: "OH", required_consumer_ids: ["B1", "B2"],
      loan: { loan_amount_cents: "41200000", rate_pct: "6.375", term_months: 360, pi_cents: "257034", product: "Fixed Rate", loan_type: "Conventional", purpose: "Purchase", prepayment_penalty: false, balloon: false, arm: false, loan_id_number: this.appId, mic_number: this.miCertificateNumber || null, first_payment_date: "2027-01-01", maturity_date: "2056-12-01" },
      apr: { apr_calculation_id: apr.output["apr_calculation_id"], apr_pct: apr.output["apr_disclosed_str"], finance_charge_cents: apr.output["finance_charge_cents"], amount_financed_cents: apr.output["amount_financed_cents"], total_of_payments_cents: apr.output["total_of_payments_cents"], tip_pct: String(Number(apr.output["tip_pct"]).toFixed(3)) },
      fees: this.CD_FEES(), escrow: { established: true, monthly_escrow_cents: "61500", initial_escrow_payment_cents: "124000", escrowed_costs_year1_cents: "738000", non_escrowed_costs_year1_cents: "0" },
      parties: { borrowers: [this.A, this.B], seller_name: this.SELLER, creditor_name: "Partner Bank, N.A.", creditor_nmlsr_id: "123456", mlo_name: "Ada Okonkwo", mlo_nmlsr_id: "987654", settlement_agent_name: "Buckeye Title Agency LLC", settlement_agent_license_id: "OH-TA-2210" },
      dates: { date_issued: "2026-11-12", closing_date: "2026-11-18", disbursement_date: "2026-11-18" }, property_address: this.ADDRESS, cash_to_close_cents: "4399700", lender_credits_cents: "51500", payoffs_and_payments_cents: "0", rescindable: false }, DISCLOSURE);
    if (opts.deliveries === false) return this.cdDisclosureId;
    this.at(EST("2026-11-13", "09:14"));
    for (const consumer of ["B1", "B2"]) await this.tool(scope, "25.2", "deliverDisclosure", { disclosure_id: this.cdDisclosureId, consumer_id: consumer, channel: "esign_portal", at: EST("2026-11-13", "09:14"), esign_consent_id: `ESIGN-P-${consumer}`, ...(consumer === "B1" ? { gate_run: { run_id: "RUN-CD-P-1", open: true, apr_verdict: "pass", blocked_channels: [] } } : {}) }, DISCLOSURE);
    if (opts.receipts !== false) {
      this.at(EST("2026-11-13", "09:30"));   // both e-sign receipts land 09:30; the second completes the waiting-period computation
      for (const consumer of ["B1", "B2"]) await this.tool(scope, "25.2", "recordReceipt", { disclosure_id: this.cdDisclosureId, consumer_id: consumer, evidence: "esign_confirmed", at: EST("2026-11-13", "09:30"), evidence_document_id: `DOC-ESIGN-P-${consumer}` }, DISCLOSURE);
      const wp = await this.tool(scope, "25.2", "computeEarliestConsummation", { disclosure_id: this.cdDisclosureId }, DISCLOSURE); assert.equal(wp.output["earliest_consummation_date"], "2026-11-17");
      this.at(EST("2026-11-13", "10:00")); const rc = await this.tool(scope, "22.4", "reconcileToCd", { worksheet_id: this.worksheetId, cd_disclosure_id: this.cdDisclosureId, cd_version: 1, cd_cash_to_close_cents: "4399700", cd_lines: [], worksheet_lines: [] }, VERIFICATION);
      assert.equal(rc.output["reconciled_to_cd"], true, JSON.stringify(rc.output).slice(0, 400));
    }
    return this.cdDisclosureId;
  }
  /** 24.4 Mon Nov 16 11:00 (INT-O5-3: "CPL/wire verification Mon Nov 16"): the CPL naming the partner and Supermortgage received; the consummation gates evaluated. */
  async titleCplAndGates(): Promise<void> {
    const scope = { app: this.appId }; const R = this.R;
    this.at(EST("2026-11-16", "11:00"));
    await this.tool(scope, "24.4", "requestCPL", { order_id: this.titleOrderId, partner_name: this.PARTNER_NAME, sm_addressee_required: true, at: EST("2026-11-16", "11:00") }, CLOSER);
    this.at(EST("2026-11-16", "11:05"));
    const cpl = await this.tool(scope, "24.4", "requestCPL", { op: "receive", order_id: this.titleOrderId, cpl_document_id: `doc-cpl-${R}`, cpl_date: "2026-11-16", cpl_underwriter_party_id: this.UNDERWRITER_PARTY, cpl_agent_party_id: this.AGENT_PARTY, addressees: [`${this.PARTNER_NAME}, its successors and/or assigns`, "Supermortgage LLC, as bailee/secured party"], partner_name: this.PARTNER_NAME, sm_addressee_required: true, funding_date: "2026-11-18", at: EST("2026-11-16", "11:05") }, CLOSER);
    assert.equal(cpl.output["open"], true, JSON.stringify(cpl.output));
    // the disbursement date is a fact the clearance check needs (SM_PAYOFF_GOOD_THROUGH_GATE is "disbursement_date_unknown" without it — vacuously open for a purchase with no liens to pay)
    this.at(EST("2026-11-16", "11:10"));
    const gates = await this.tool(scope, "24.4", "evaluateGates", { command: "consummate", clear_when_ready: true, disbursement_date: "2026-11-18", funding_date: "2026-11-18", consummation_on: "2026-11-18", partner_name: this.PARTNER_NAME, at: EST("2026-11-16", "11:10") }, CLOSER);
    assert.equal(gates.output["open"], true, String(gates.output["refusal"]));
    const clearance = gates.output["clearance"] as { can_clear: boolean; missing: string[] } | null; assert.ok(clearance?.can_clear, `24.4 clearance: ${JSON.stringify(clearance)}`);
  }
  /**
   * 26.1 Mon Nov 16 13:00 (26 README INT-O7-3: "documents released Mon Nov 16"): the note terms for a Nov 18 disbursement (P&I $2,570.34; first payment
   * Jan 1, 2027; maturity Dec 1, 2056), the doc-gen gates, the closing snapshot, the OH purchase eNote set (3200e, the Ohio mortgage 3036, the final
   * 1003 — no H-8: not rescindable), the SMART Doc, QC, the release to the settlement agent 16:00; Tue Nov 17 09:00 the released set folded into 26.2's closing.
   */
  async closingDocuments(opts: { snapshot?: Record<string, unknown> } = {}): Promise<void> {
    const scope = { app: this.appId }; const snapshot = { ...this.CLOSING_SNAPSHOT(), ...(opts.snapshot ?? {}) };
    this.at(EST("2026-11-16", "13:00"));
    const terms = await this.tool(scope, "26.1", "computeNoteTerms", { principal_cents: "41200000", note_rate_pct: "6.375", term_months: 360, scheduled_disbursement_date: "2026-11-18", state: "OH" }, CLOSER); this.noteTerms = terms.output;
    assert.equal(terms.output["pi_cents"], "257034"); assert.equal(terms.output["first_payment_date"], "2027-01-01"); assert.equal(terms.output["maturity_date"], "2056-12-01");
    const g = await this.tool(scope, "26.1", "evaluateDocGenGates", { gate: this.DOCGEN_GATE }, CLOSER); assert.equal(g.output["gate_open"], true, JSON.stringify(g.output)); this.closingSetId = g.output["set_id"] as string;
    await this.tool(scope, "26.1", "takeClosingSnapshot", { set_id: this.closingSetId, snapshot, gate: this.DOCGEN_GATE }, CLOSER);
    const rendered = await this.tool(scope, "26.1", "renderDocument", { set_id: this.closingSetId }, CLOSER);
    const docs = rendered.output["documents"] as { document_id: string; kind: string; form_number: string; data_hash: string }[]; this.noteDataHash = docs.find((d) => d.kind === "enote")!.data_hash; assert.equal(this.noteDataHash, terms.output["data_hash"]);
    assert.ok(!docs.some((d) => d.kind === "rescission_notice_h8"), "no H-8 in a purchase package");
    const smart = await this.tool(scope, "26.1", "buildSmartDocENote", { set_id: this.closingSetId }, CLOSER);
    await this.tool(scope, "26.1", "runDocumentQc", { set_id: this.closingSetId, upstream: { enote: smart.output, cd: { loan_amount_cents: "41200000", note_rate_pct: "6.375", pi_cents: "257034", org_nmlsr_id: "123456", mlo_nmlsr_id: "987654", first_payment_date: "2027-01-01" }, du: { loan_amount_cents: "41200000", note_rate_pct: "6.375", term_months: 360 }, lock: { note_rate_pct: "6.375" }, title: { vesting_text: snapshot.vesting_text, legal_description: snapshot.legal_description }, urla_1003: { org_nmlsr_id: "123456", mlo_nmlsr_id: "987654", loan_amount_cents: "41200000", note_rate_pct: "6.375", term_months: 360 }, note_date: "2026-11-18" } }, CLOSER);
    this.at(EST("2026-11-16", "16:00"));
    await this.tool(scope, "26.1", "releaseToSettlementAgent", { set_id: this.closingSetId, released_to_party_id: this.AGENT_PARTY, facts: { qc_pass_gate_open: true, template_version_gate_open: true } }, CLOSER);
    this.at(EST("2026-11-17", "09:00"));
    const released = (await this.eventsOf(`application_id = $1 AND type = 'closing.documents.released'`, [this.appId]))[0]!;
    await this.tool(scope, "26.2", "runPreSessionChecks", { op: "upstream", closing_id: this.CLOSING_ID, event: { type: "closing.documents.released", occurredAt: EST("2026-11-16", "16:00"), payload: released.payload } }, CLOSER);
  }
  /**
   * 26.3 worked example 5 (wet state, purchase), Wed Nov 18 08:00 ET on the closing date: the funding opened (not rescindable → funds on the note date;
   * `funding_type = wet`, per diem 412,000 × 6.375 % ÷ 365 = $71.96, prepaid Nov 18–30 = 13 days = $935.48, first payment Jan 1, 2027, LPI Dec 1), the
   * worksheet (gross − prepaid interest − $1,240.00 escrow deposit + $515.00 lender credit = $410,339.52 — discrepancy b) reconciled to the settlement
   * statement. The wire itself waits for the review (gap 4).
   */
  async openFunding(): Promise<void> {
    const scope = { app: this.appId }; const F = this.FUNDING_ID;
    this.at(EST("2026-11-18", "08:00"));
    const open = await this.tool(scope, "26.3", "computeDates", { op: "open", funding_id: F, state: "OH", transaction_type: "purchase", time_zone: "America/New_York", closing_date: "2026-11-18", closing_id: this.CLOSING_ID, partner_id: this.PARTNER_ID, partner_loan_number: `PL-P-${this.R}`, gross_loan_cents: "41200000", note_rate_pct: "6.375", note_first_payment_date: "2027-01-01" }, FUNDER);
    const cal = open.output["calendar"] as Record<string, unknown>; assert.equal(cal["funding_type"], "wet"); assert.equal(cal["earliest_funding_date"], "2026-11-18"); assert.equal(cal["rescission_expires_at"], null);
    await this.tool(scope, "26.3", "buildFundingWorksheet", { funding_id: F, version: 1, cd_version: 1, gross_loan_cents: "41200000", prepaid_interest_cents: "93548", escrow_deposit_cents: "124000", lender_credits_cents: "51500" }, FUNDER);
    const rec = await this.tool(scope, "26.3", "reconcileToSettlementStatement", { funding_id: F, worksheet_id: `${F}:ws:1`, agent_requested_net_cents: "41033952" }, FUNDER);
    assert.equal((rec.output["item"] as { status: string }).status, "pass", JSON.stringify(rec.output).slice(0, 400));
  }
  /**
   * 26.2 Wed Nov 18 (worked example 2's clock): 09:30 the E-SIGN consent verified and the pre-session checks passed; 10:05 the RON session opened, both
   * signers proofed (credential analysis + KBA), the eNote signed 10:29 / 10:31 = `closing.consummated{note_date 2026-11-18}` (no rescission period), the
   * mortgage 10:40 and acknowledged 10:42, the Authoritative Copy tamper-sealed 10:44 and registered 10:52 (MERS_PROC_ENOTE_REGISTER_1BD due Thu Nov 19),
   * the platform's audit trail on file 10:58 (SM_O72_AUDIT_TRAIL_BEFORE_FUNDING_GATE).
   */
  async signingSession(): Promise<void> {
    const scope = { app: this.appId }; const R = this.R;
    this.at(EST("2026-11-18", "09:30"));
    await this.tool(scope, "26.2", "verifyEsignConsent", { closing_id: this.CLOSING_ID, consent: this.CLOSING_CONSENT }, CLOSER);
    const pre = await this.tool(scope, "26.2", "runPreSessionChecks", { closing_id: this.CLOSING_ID, consent: this.CLOSING_CONSENT, facts: this.PRE_SESSION_FACTS }, CLOSER); assert.equal(pre.output["passed"], true, JSON.stringify(pre.output["blocking"]));
    this.at(EST("2026-11-18", "10:05"));
    await this.tool(scope, "26.2", "openSigningSession", { closing_id: this.CLOSING_ID, session_id: this.SESSION_ID, signer_party_ids: ["B1", "B2"], notary: this.NOTARY, consent_record_id: this.CONSENT_ID }, CLOSER);
    for (const [party, hhmm, correct] of [["B1", "10:08", 5], ["B2", "10:12", 4]] as const) { this.at(EST("2026-11-18", hhmm)); await this.tool(scope, "26.2", "monitorSession", { op: "identity", closing_id: this.CLOSING_ID, party_id: party, method: "credential_analysis_kba", credential_type: "driver_license", credential_analysis_result: "pass", kba_attempts: [{ questions: 5, correct, seconds: 68, at: EST("2026-11-18", hhmm), notary_party_id: this.NOTARY.party_id }], notary_party_id: this.NOTARY.party_id, vendor: "Proof" }, CLOSER); }
    this.at(EST("2026-11-18", "10:15"));
    await this.tool(scope, "26.2", "monitorSession", { op: "start", closing_id: this.CLOSING_ID }, CLOSER);
    await this.tool(scope, "26.2", "monitorSession", { op: "enote_created", closing_id: this.CLOSING_ID, closing_document_id: `DOC-ENOTE-P-${R}`, min: this.MIN, partner_org_id: "1000123" }, CLOSER);
    for (const [party, hhmm] of [["B1", "10:20"], ["B2", "10:22"]] as const) { this.at(EST("2026-11-18", hhmm)); await this.tool(scope, "26.2", "monitorSession", { op: "sign", closing_id: this.CLOSING_ID, closing_document_id: `DOC-1003-P-${R}`, kind: "final_1003", signer_party_id: party, signed_at: EST("2026-11-18", hhmm), signature_method: "esign_ron", required_note_signers: ["B1", "B2"] }, CLOSER); }
    this.at(EST("2026-11-18", "10:29")); await this.tool(scope, "26.2", "monitorSession", { op: "sign", closing_id: this.CLOSING_ID, closing_document_id: `DOC-ENOTE-P-${R}`, kind: "enote", signer_party_id: "B1", signed_at: EST("2026-11-18", "10:29"), signature_method: "esign_ron", required_note_signers: ["B1", "B2"] }, CLOSER);
    this.at(EST("2026-11-18", "10:31")); const signed = await this.tool(scope, "26.2", "monitorSession", { op: "sign", closing_id: this.CLOSING_ID, closing_document_id: `DOC-ENOTE-P-${R}`, kind: "enote", signer_party_id: "B2", signed_at: EST("2026-11-18", "10:31"), signature_method: "esign_ron", required_note_signers: ["B1", "B2"] }, CLOSER);
    assert.equal(signed.output["note_date"], "2026-11-18"); assert.ok(signed.events.some((e) => e.type === "closing.consummated"), "the eNote's second signature is consummation");
    this.at(EST("2026-11-18", "10:40"));
    for (const party of ["B1", "B2"]) await this.tool(scope, "26.2", "monitorSession", { op: "sign", closing_id: this.CLOSING_ID, closing_document_id: `DOC-MTG-P-${R}`, kind: "security_instrument", signer_party_id: party, signed_at: EST("2026-11-18", "10:40"), signature_method: "esign_ron", required_note_signers: ["B1", "B2"] }, CLOSER);
    this.at(EST("2026-11-18", "10:42")); await this.tool(scope, "26.2", "monitorSession", { op: "notarial_act", closing_id: this.CLOSING_ID, closing_document_id: `DOC-MTG-P-${R}`, kind: "security_instrument", act_type: "acknowledgment", completed_at: EST("2026-11-18", "10:42"), certificate_indicates_communication_technology: true, recordable: true, last: true, notary_party_id: this.NOTARY.party_id }, CLOSER);
    const copy = `<SMART_DOCUMENT version="1.02"><DATA min="${this.MIN}" amount="412000.00" rate="6.375"/></SMART_DOCUMENT>`;
    const { createHash } = await import("node:crypto"); const seal = createHash("sha256").update(copy).digest("hex");
    this.at(EST("2026-11-18", "10:44")); await this.tool(scope, "26.2", "validateAuthoritativeCopy", { op: "seal", closing_id: this.CLOSING_ID, seal_hash: seal, signing_completed_at: EST("2026-11-18", "10:31"), authoritative_copy_ref: `EV-P-${R}`, tamper_sealed_at: EST("2026-11-18", "10:44") }, CLOSER);
    this.at(EST("2026-11-18", "10:46")); const v = await this.tool(scope, "26.2", "validateAuthoritativeCopy", { closing_id: this.CLOSING_ID, authoritative_copy: copy }, CLOSER); assert.equal(v.output["gate_open"], true, String(v.output["reason"]));
    this.at(EST("2026-11-18", "10:52")); const reg = await this.tool(scope, "26.2", "registerENote", { closing_id: this.CLOSING_ID }, CLOSER); assert.equal(reg.output["accepted"], true);
    this.at(EST("2026-11-18", "10:58")); const trail = createHash("sha256").update(`audit-trail-${this.SESSION_ID}`).digest("hex");
    // RON: the provider-held session recording reference and the notary's electronic journal entry accompany the tamper-sealed trail (R.C. 147.65 retention)
    const audit = await this.tool(scope, "26.2", "ingestAuditTrail", { closing_id: this.CLOSING_ID, document_id: `DOC-AUDIT-P-${R}`, audit_trail_hash: trail, platform_hash: trail, recording_ref: `proof-rec-${this.SESSION_ID}`, journal_ref: `journal-${this.NOTARY.commission_number}-${R}` }, CLOSER); assert.equal(audit.output["gate_open"], true, JSON.stringify(audit.output).slice(0, 300));
  }
  /** The documents and the session in one step (a caller without the funding's 08:00 opening between them). */
  async closeAndSign(opts: { snapshot?: Record<string, unknown> } = {}): Promise<void> { await this.closingDocuments(opts); await this.signingSession(); }
  /** REGZ_1026_19F4_SELLER_CD_GATE: the settlement agent's seller CD and the creditor's copy, received the day of consummation (11:00, after the table). */
  async sellerCd(): Promise<void> {
    this.at(EST("2026-11-18", "11:00"));
    await this.tool({ app: this.appId }, "25.2", "scheduleCorrectedCd", { op: "seller_cd", document_id: `DOC-SELLER-CD-${this.R}`, received_at: EST("2026-11-18", "11:00"), provided_by: "settlement_agent" }, DISCLOSURE);
  }
  /** 26.2's post-signing review of the executed set, 11:40 ET (SM_O72_POST_SIGNING_REVIEW_4H): every signature attributable and dated, the RON certificate complete, no handwritten change → `closing.execution_review.passed` (26.3 FC_DOCS_EXECUTED_QC reads it). */
  async executionReview(): Promise<void> {
    this.at(EST("2026-11-18", "11:40"));
    const r = await this.tool({ app: this.appId }, "26.2", "reviewExecution", { closing_id: this.CLOSING_ID, documents: this.EXECUTED_DOCUMENTS(), at: EST("2026-11-18", "11:40") }, CLOSER);
    assert.equal(r.output["passed"], true, JSON.stringify(r.output["defects"])); assert.equal(r.output["execution_status"], "execution_reviewed");
  }
  /**
   * 26.3 after the 11:40 review (gap 4): every condition passes (rescission and payoffs n/a on a purchase; the gift transfer verified; the worksheet
   * reconciled to the CD), the funding is authorized 11:52 (every gate re-asserted), the advance approved, the wire prepared 12:00 / released 12:10 under
   * dual control (the funding_approver) / accepted 12:11 (IMAD), the agency confirms receipt 12:30, the disbursement authorization (the wet-state step,
   * citing the 11:40 review) goes to the agent 12:35, and the agency's disbursement 13:15 → `loan.funded{disbursement_date 2026-11-18}`.
   */
  async disburse(): Promise<void> {
    const scope = { app: this.appId }; const R = this.R; const F = this.FUNDING_ID;
    this.at(EST("2026-11-18", "11:41")); const conditions = await this.tool(scope, "26.3", "evaluateFundingConditions", { funding_id: F, facts: this.FUNDING_FACTS(EST("2026-11-18", "11:41")) }, FUNDER); assert.equal(conditions.output["passed"], true, JSON.stringify({ blocking: conditions.output["blocking_codes"], pending: conditions.output["pending_codes"] }));
    this.at(EST("2026-11-18", "11:52")); await this.tool(scope, "26.3", "requestWarehouseAdvance", { funding_id: F, conditions: conditions.output, rescission: { status: "not_applicable" }, fraud_hold: { fraud_hold: false }, ptf: { ptf_cleared: true }, cash_to_close: { worksheet: { reconciled_to_cd: true, sufficient: true } }, gifts: [{ gift_id: this.giftId, status: "transfer_verified" }] }, FUNDER);
    await this.tool(scope, "26.3", "requestWarehouseAdvance", { funding_id: F, op: "advance_approved", advance_id: `ADV-P-${R}` }, FUNDER);
    this.at(EST("2026-11-18", "12:00")); const wireId = `W-P-${R}`;
    await this.tool(scope, "26.3", "prepareWire", { funding_id: F, wire_id: wireId, record: this.VERIFIED_WIRE, instructions_hash: this.VERIFIED_WIRE.instructions_hash, instructions_source: "verified_record", value_date: "2026-11-18", prepared_at: EST("2026-11-18", "12:00"), run_id: "run-funder-p-1", editors: ["u-analyst"], borrower_last_name: "Purchaser", property_short: this.ADDRESS_SHORT, funding_account_ref_hash: "sha256:funding", closing_documents: [] }, FUNDER);
    this.at(EST("2026-11-18", "12:10")); await this.tool(scope, "26.3", "prepareWire", { funding_id: F, op: "release", wire_id: wireId, bank_ref: "BK-P-1", released_at: EST("2026-11-18", "12:10") }, APPROVER);
    this.at(EST("2026-11-18", "12:11")); await this.tool(scope, "26.3", "prepareWire", { funding_id: F, op: "accept", wire_id: wireId, imad: "20261118B1QGC01R000412", accepted_at: EST("2026-11-18", "12:11") }, FUNDER);
    this.at(EST("2026-11-18", "12:30")); await this.tool(scope, "26.3", "notifySettlementAgent", { funding_id: F, op: "agent_receipt", funds_received_by_agent_at: EST("2026-11-18", "12:30") }, FUNDER);
    this.at(EST("2026-11-18", "12:35")); await this.tool(scope, "26.3", "notifySettlementAgent", { funding_id: F, op: "disbursement_authorization", execution_review_passed_at: EST("2026-11-18", "11:40"), issued_at: EST("2026-11-18", "12:35"), channel: "portal", funding_number: `FN-P-${R}` }, FUNDER);
    this.at(EST("2026-11-18", "13:15"));
    const funded = await this.tool(scope, "26.3", "confirmDisbursement", { funding_id: F, disbursement_date: "2026-11-18", confirmed_at: EST("2026-11-18", "13:15"), source: "final_settlement_statement", evidence_document_id: "DOC-FSS-P", escrow_deposit_cents: "124000" }, FUNDER);
    assert.ok(funded.events.some((e) => e.type === "loan.funded"));
    const lf = funded.output["loan_funded"] as Record<string, unknown>; assert.equal(lf["per_diem_cents"], "7196"); assert.equal(lf["prepaid_interest_cents"], "93548"); assert.equal(lf["prepaid_days"], 13); assert.equal(lf["first_payment_date"], "2027-01-01");
  }
  /** 24.6 R10 / SM_MI_ACTIVATE_1BD: activation requested at the note date (Nov 18 13:30); the insurer confirms 15:05 with the effective date Nov 18 → `active` (30.2's OB-009 reads it at 15:20 — discrepancy c). */
  async activateMi(): Promise<Record<string, unknown>> {
    const scope = { app: this.appId };
    this.at(EST("2026-11-18", "13:30")); await this.tool(scope, "24.6", "requestActivation", { note_date: "2026-11-18", at: EST("2026-11-18", "13:30") }, CLOSER);
    this.at(EST("2026-11-18", "15:05")); const active = await this.tool(scope, "24.6", "requestActivation", { op: "confirm", activation_effective_date: "2026-11-18", certificate_number: this.miCertificateNumber, confirmed_at: EST("2026-11-18", "15:05") }, CLOSER);
    assert.equal(active.output["status"], "active");
    const cert = await this.entity("mi_certificates", this.miCertificateId); assert.ok(cert, "the mi_certificates row"); return cert;
  }
  /**
   * 30.2 worked example 2: POST /v1/applications/{id}/fund at 15:20 EST boards ONE servicing loan from the record — 26.3's `loan.funded` on the log, 26.1's
   * note hash, 26.2's consummation and MIN — with the purchase snapshot for what the record does not carry: the OH note ($412,000 at 6.375 %, the
   * late-charge terms 26.1 computed), the final CD (P&I $2,570.34; escrow $615.00 + MI $130.47; deposit $1,240.00; 13 days' prepaid interest), 30.3's
   * initial analysis (county taxes $520.00 + hazard $95.00 = $615.00/month; deposit $1,240.00), LTV 90 %, the active MI certificate (coverage 25 %,
   * monthly BPMI, the §4903 initial disclosure), the Columbus property (appraised $460,000; original value $457,800), the hazard binder effective Nov 18
   * (gap 1: 24.5's rows do not exist for a TBD purchase). `snapshotOverrides` replace whole top-level fields (30.2's correction rule).
   */
  async board(snapshotOverrides: Record<string, unknown> = {}): Promise<string> {
    this.at("2026-11-18T20:20:00.000Z");   // 15:20 EST Wed Nov 18 — 30.2 worked example 2's `loan.funded` hour
    const mi = this.miCertificateId ? await this.entity("mi_certificates", this.miCertificateId) : null;
    const t = this.noteTerms;
    const r = await this.call("POST", `/v1/applications/${this.appId}/fund`, { actor: FUNDING, snapshot: {
      note: { amount_cents: "41200000", note_rate_pct: "6.375", term_months: 360, first_payment_date: "2027-01-01", maturity_date: "2056-12-01", late_charge_pct: String(t["late_charge_pct"] ?? "5.00"), late_charge_grace_days: Number(t["late_charge_grace_days"] ?? 15), partner_nmlsr_id: "123456", mlo_nmlsr_id: "987654" },
      final_cd: { document_id: this.cdDisclosureId, pi_cents: "257034", monthly_escrow_cents: "61500", initial_escrow_deposit_cents: "124000", prepaid_interest_cents: "93548", prepaid_interest_days: 13, compliance_tests_passed: true },
      escrow_analysis: { source: "origination", type: "initial", required_start_balance_cents: "1000", cushion_cents: "123000", monthly_escrow_cents: "61500", lines: [{ line_type: "county_tax", annual_amount_cents: "624000", monthly_cents: "52000" }, { line_type: "hazard", annual_amount_cents: "114000", monthly_cents: "9500" }], status: "active" },
      ltv_pct: "90.00",
      mi: mi ? { certificate_number: String(mi["certificate_number"] ?? this.miCertificateNumber), status: String(mi["status"]), coverage_pct: String(mi["coverage_pct"]), premium_plan: String(mi["premium_plan"]), monthly_premium_cents: String(mi["monthly_premium_cents"]), hpa_disclosure_kind: mi["hpa_disclosure_kind"] ?? null } : null,
      property: { address_line1: "1187 Oakwood Ave", city: "Columbus", state: "OH", postal_code: "43206", county: "Franklin", apn: this.APN, property_type: "sfr", units: 1, occupancy: "primary", flood_zone: "X", sfha: false, appraised_value_cents: "46000000", original_value_cents: "45780000" },
      hazard: { verified: true, mortgagee_clause_partner_isaoa_co_sm: true, expires_on: "2027-11-18" },
      ...snapshotOverrides } });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 2000));
    this.boardResult = r.body; this.loanId = r.body["loan_id"] as string; return this.loanId;
  }
  /** 30.4: the servicing hand-off opened on the boarded loan (HO items from `boarded_at`; the MI certificate present). Runs after board(). */
  async openServicingHandoff(): Promise<void> {
    this.at("2026-11-18T20:25:00.000Z");
    await this.tool({ loan: this.loanId }, "30.4", "openHandoff", { loan_id: this.loanId, application_id: this.appId, boarded_at: "2026-11-18T20:20:00.000Z", first_payment_date: "2027-01-01", mi_certificates_present: true, escrowed: true }, { kind: "agent", id: "boarding" });
  }
  /** Every phase in order — the whole purchase to boarding, the clock never turning back (the test settles the flows between them). */
  async phases(): Promise<{ name: string; run: () => Promise<unknown> }[]> {
    let du: { submission_id: string; interpretation_id: string | null; request_hash: string; conditions: string[] } | null = null;
    return [
      { name: "seedPricing", run: () => this.seedPricing() }, { name: "openLead", run: () => this.openLead() }, { name: "openApplication", run: () => this.openApplication() }, { name: "interview", run: () => this.interview() }, { name: "signContract", run: () => this.signContract() },
      { name: "verifyAndOrderCredit", run: () => this.verifyAndOrderCredit() }, { name: "quote", run: () => this.quote() }, { name: "declareAndVerifyAssets", run: () => this.declareAndVerifyAssets() }, { name: "miQuotesAndElection", run: () => this.miQuotesAndElection() }, { name: "deliverLe", run: () => this.deliverLe() }, { name: "recordIntent", run: () => this.recordIntent() }, { name: "appraisalOrder", run: () => this.appraisalOrder() },
      { name: "duSubmitAndInterpret", run: async () => { du = await this.duSubmitAndInterpret(); return du; } }, { name: "quoteForLock", run: () => this.quoteForLock() }, { name: "requestLock", run: () => this.requestLock() }, { name: "executeLockAndCommit", run: () => this.executeLockAndCommit() },
      { name: "conditionalApproval", run: () => this.conditionalApproval(du!) }, { name: "miOrderAndCommitment", run: () => this.miOrderAndCommitment() }, { name: "appraisalReceipt", run: () => this.appraisalReceipt() }, { name: "miScheduleAndDisclosure", run: () => this.miScheduleAndDisclosure() }, { name: "giftAndFundsToClose", run: () => this.giftAndFundsToClose() },
      { name: "titleOrder", run: () => this.titleOrder() }, { name: "clearToClose", run: () => this.clearToClose() }, { name: "scheduleClosing", run: () => this.scheduleClosing() }, { name: "titleCommitmentAndWire", run: () => this.titleCommitmentAndWire() }, { name: "closingDisclosure", run: () => this.closingDisclosure() }, { name: "titleCplAndGates", run: () => this.titleCplAndGates() },
      { name: "closingDocuments", run: () => this.closingDocuments() }, { name: "openFunding", run: () => this.openFunding() }, { name: "signingSession", run: () => this.signingSession() }, { name: "sellerCd", run: () => this.sellerCd() }, { name: "executionReview", run: () => this.executionReview() }, { name: "disburse", run: () => this.disburse() }, { name: "activateMi", run: () => this.activateMi() }, { name: "board", run: () => this.board() }, { name: "openServicingHandoff", run: () => this.openServicingHandoff() },
    ];
  }
}
