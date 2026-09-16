/**
 * 35.6 — the wet-state and paper-note branches of the state machine (worked example B, T16/T17): the pre-signing funding chain the day before the
 * session (26.3 `evaluateFundingConditions{op: pre_signing}` → `requestWarehouseAdvance` → 27.1 → `prepareWire`; the funding_approver's release;
 * the bank's acceptance before signing — `SM_O73_WET_FUNDS_AT_TABLE_GATE`), the paper note's custody chain after signing (26.2 `seedCustodyRecord`
 * / `trackPaperNote` from the FAKE courier's scans; 27.1 `trackCollateral{trust_receipt}` → `warehouse.note.received`, `SM_WH_WET_NOTE_DELIVERY_5BD`),
 * 27.1's bailee letter (rendered by the pass, signed by a human `officer{sm}` — never by the agent) and 29.4's paper custodian package under it
 * (`prepareCustodianPackage`, `scheduleShipment` through the FAKE carrier, `trackShipment{received | certified}` from the custodian's scans).
 * Every input is derived from the record (rule 2); every owner runs as its own agent inside the pass's transaction (35.1's seam).
 */
import type { StepContext } from "./orchestration-35-6.ts";
import type { StepOutcome } from "./steps-35-6.ts";
import type { OrchRecord } from "./facts-35-6.ts";
import { RecordGap, src } from "./facts-35-6.ts";
import { partyFacts, loanTerms, rescissionFacts, closingFacts, type ClosingFacts } from "./facts-35-6-b.ts";
import { fundingChain, wireChain, bookAdvance, fundingIdOf, WAREHOUSE, S, civil } from "./steps-35-6-b.ts";
import { storeDocument } from "./documents-port-35-6.ts";
import { fundingJurisdictionRule } from "../closing/ops-26-3.ts";
import { FACILITY_FIXTURE } from "../warehouse/ops-27-1.ts";
import { addBusinessDays, creditor } from "../../kernel/calendar/business.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";

type Row = Record<string, unknown>;
const FUNDER = { kind: "agent", id: "funder" } as const;
const CLOSER = { kind: "agent", id: "title-closing" } as const;
const SECONDARY = { kind: "agent", id: "secondary" } as const;
const POST_CLOSING = { kind: "agent", id: "post-closing" } as const;   // 26.4's allowlisted caller (the MIN registration in steps-35-6-b runs as it too)
// steps-35-6-c.ts's helpers, kept local: this module is imported by steps-35-6-b.ts (the wet chain) and steps-35-6-c.ts (the paper path); importing c from here would evaluate c's step literals before b's `exitOn` exists
const needClosing = (rec: OrchRecord): ClosingFacts => { const c = closingFacts(rec); if (!c) throw new RecordGap("closing.scheduled", "no closing on the record (26.2)"); return c; };
const loanIdOf = (rec: OrchRecord): string | null => rec.loanId ?? S(rec.payload("loan.boarded")?.["loan_id"]) ?? S(rec.payload("loan.staged")?.["loan_id"]) ?? null;
async function servicingLoanNumber(ctx: StepContext, loanId: string): Promise<string> {
  const row = (await ctx.rt.db.query<{ n: string }>(`SELECT servicer_loan_number AS n FROM loans WHERE id = $1`, [loanId]))[0];
  if (!row) throw new RecordGap("loans", `no loans row ${loanId} (30.2)`);
  return row.n;
}

/** The document custodian on the platform (the partner's Form 2017 FCC as SM's bailee — 26.2's default custodian, 27.1's bailee, 29.4's custodian): the `parties` row of type `custodian`; none is a gap the custodian agreement's owner fills (26.2 prerequisite). */
export async function custodianParty(rec: OrchRecord): Promise<{ id: string; legal_name: string; fin: string | null }> {
  const rows = await rec.q.query<{ id: string; legal_name: string; fin: string | null }>(`SELECT id::text AS id, legal_name, servicer_number AS fin FROM parties WHERE party_type = 'custodian' ORDER BY created_at, id LIMIT 1`);
  if (!rows[0]) throw new RecordGap("parties{party_type: custodian}", "no document custodian party on the platform (26.2's custodian agreement / 27.1's bailee)");
  return rows[0];
}

/**
 * Wet states (26.3's `jurisdiction_rules.wet_states`): from the business day before the note date the pass opens 26.3's funding calendar on the scheduled closing date,
 * runs the pre-signing subset of the funding conditions and the advance, prepares the wire (value date = closing date), waits on the funding_approver's release, records the
 * bank's acceptance and books 27.1's advance — all before the session opens. Returns the wait while a person or the bank is owed; null when the wet chain is complete or not applicable.
 */
export async function wetPreSigningFunding(ctx: StepContext): Promise<StepOutcome | null> {
  let rec = ctx.rec; const closing = needClosing(rec); const now = ctx.now;
  if (fundingJurisdictionRule(closing.state).wet_dry !== "wet") return null;
  // a rescindable loan (a refinance of the borrower's principal dwelling) has no table funding: 26.3's earliest funding date follows the rescission expiry (BEFORE_EARLIEST_FUNDING_DATE), so its funding runs on the dry-shaped path after the execution review — the session opens first
  if (closing.rescindable) return null;
  if (rec.has("warehouse.advance.funded")) return null;
  // 26.3's SM_O73_CONDITIONS_EVAL_2BH (wet): the pre-signing run is scheduled for `closing.scheduled` − 1 business day (creditor calendar)
  const dayBefore = addBusinessDays(D(closing.scheduled_note_date), -1, creditor);
  if (civil(rec, now) < dayBefore) return null;
  if (!rec.has("funding.requested")) {
    const terms = loanTerms(rec); const parties = await partyFacts(rec, closing); const note = rec.entities("closing_data_snapshots").at(-1);
    const noteTerms = (note?.data["payload"] as Row | undefined)?.["note_terms"] as Row | undefined;
    const firstPayment = S(noteTerms?.["first_payment_date"]) ?? S(rec.payload("funding.interest_mode.decided")?.["first_payment_date"]);
    await ctx.run({ process: "26.3", name: "computeDates", actor: FUNDER, input: { op: "open", funding_id: fundingIdOf(rec), state: closing.state, transaction_type: rec.app.transaction_type ?? "limited_cash_out", time_zone: closing.time_zone, closing_date: closing.scheduled_note_date, rescindable: closing.rescindable, partner_id: parties.partner_id, partner_loan_number: S(rec.intake()?.["partner_loan_number"]) ?? `PL-${rec.app.id.slice(0, 8)}`, gross_loan_cents: String(terms.loan_amount_cents.value), note_rate_pct: terms.note_rate_pct.value, ...(firstPayment ? { note_first_payment_date: firstPayment } : {}), closing_id: closing.closing_id },
      detail: { sources: { closing: src("entity", `closings:${closing.row.id}:${closing.row.version}`, "26.2"), gross_loan_cents: terms.loan_amount_cents.source, note_rate_pct: terms.note_rate_pct.source, partner: parties.sources["partner"]!, ...(noteTerms ? { first_payment: src("entity", `closing_data_snapshots:${note!.id}`, "26.1") } : {}) }, wet: true, day_before: dayBefore } });
    rec = await ctx.refresh();
  }
  const funding = rec.payload("funding.requested")!;
  if (String(funding["funding_type"]) !== "wet") return null;   // 26.3 decided the calendar dry after all (an override on the record) — the dry path funds after the review
  if (!(rec.has("funding.authorized") && rec.has("warehouse.advance.approved"))) {
    const r = await fundingChain(ctx, { stage: "pre_signing", resc: rescissionFacts(rec, now) });
    if (r.wait || r.hold) return r;
    rec = await ctx.refresh();
  }
  if (!rec.has("funding.wire.accepted")) {
    const r = await wireChain(ctx);
    if (r.wait || r.hold) return r;
    rec = await ctx.refresh();
  }
  // funds are at the table (funding.wire.accepted — SM_O73_WET_FUNDS_AT_TABLE_GATE satisfied): 27.1's advance package is handed to the funding_approver here but never holds the session; `wireReleased` re-arms the same wait after consummation
  const booked = await bookAdvance(ctx);
  return booked?.hold ? booked : null;
}

/**
 * The paper note after signing (26.2 custody chain; 27.1 rule 4): the custody record seeded at the settlement agent, the FAKE courier's pickup and the custodian's receipt
 * scans replayed into 26.2 `trackPaperNote`, then 27.1's trust receipt → `warehouse.note.received{collateral_status: secured_possession}` (satisfies `SM_WH_WET_NOTE_DELIVERY_5BD`).
 * Non-blocking: runs whatever the clock has made due; the delivery steps wait on `warehouse.note.received` only where the custodian's possession is a gate.
 */
export async function paperNoteCustody(ctx: StepContext): Promise<void> {
  let rec = ctx.rec; const closing = needClosing(rec); const now = ctx.now;
  if (closing.note_form !== "paper") return;
  const consummated = rec.last("closing.consummated"); if (!consummated) return;
  if (rec.has("warehouse.note.received")) return;
  const custodian = await custodianParty(rec);
  let custody = rec.entity("custody_records", closing.closing_id);
  if (!custody) {
    await ctx.run({ process: "26.2", name: "seedCustodyRecord", actor: CLOSER, input: { closing_id: closing.closing_id, custodian_party_id: custodian.id, settlement_agent_party_id: closing.settlement_agent_party_id, at: String(consummated.payload["consummation_at"] ?? consummated.occurredAt) }, detail: { sources: { consummated: src("event", `closing.consummated:${consummated.id}`, "26.2"), custodian: src("table", `parties:${custodian.id}`, "26.2") } } });
    rec = await ctx.refresh(); custody = rec.entity("custody_records", closing.closing_id);
  }
  const scans = ctx.fakes.courier.scans(closing.closing_id, String(consummated.payload["consummation_at"] ?? consummated.occurredAt));
  if (custody?.data["note_location"] === "settlement_agent" && now >= scans.shipped_at) {
    await ctx.run({ process: "26.2", name: "trackPaperNote", actor: CLOSER, input: { closing_id: closing.closing_id, op: "shipped", tracking_ref: scans.tracking_ref, courier_party_id: ctx.fakes.courier.partyId, at: scans.shipped_at }, detail: { sources: { scan: src("platform", `${ctx.fakes.courier.vendorName} courier pickup scan ${scans.tracking_ref}`, "35.6") } } });
    rec = await ctx.refresh(); custody = rec.entity("custody_records", closing.closing_id);
  }
  if (custody?.data["note_location"] === "courier" && now >= scans.received_at) {
    await ctx.run({ process: "26.2", name: "trackPaperNote", actor: CLOSER, input: { closing_id: closing.closing_id, op: "received", tracking_ref: scans.tracking_ref, at: scans.received_at }, detail: { sources: { scan: src("platform", `${ctx.fakes.courier.vendorName} custodian delivery scan ${scans.tracking_ref}`, "35.6") } } });
    rec = await ctx.refresh();
  }
  const received = rec.last("custody.paper_note.received"); const advance = rec.last("warehouse.advance.funded");
  if (received && advance && !rec.has("warehouse.note.received")) {
    const letter = baileeLetterOf(rec, String(advance.payload["advance_id"]));
    await ctx.run({ process: "27.1", name: "trackCollateral", actor: WAREHOUSE, input: { op: "trust_receipt", advance_id: String(advance.payload["advance_id"]), facility_id: String(advance.payload["facility_id"]), receipt_id: `TR-${closing.closing_id}`, received_at: String(received.payload["received_at"]), custody_record_id: closing.closing_id, ...(letter ? { bailee_letter_id: letter.id } : {}) },
      detail: { sources: { received: src("event", `custody.paper_note.received:${received.id}`, "26.2"), advance: src("event", `warehouse.advance.funded:${advance.id}`, "27.1"), custodian: src("table", `parties:${custodian.id}`, "26.2") } } });
  }
}

/** 27.1's bailee letter covering this loan's advance (its `bailee_letters` row lists the advance). */
export function baileeLetterOf(rec: OrchRecord, advanceId: string): { id: string; data: Row } | null {
  const rows = rec.entities("bailee_letters", (d) => Array.isArray(d["loan_list"]) && (d["loan_list"] as Row[]).some((l) => l["advance_id"] === advanceId));
  const r = rows.at(-1); return r ? { id: r.id, data: r.data } : null;
}

/**
 * 27.1 rule 5: the bailee letter for a paper note — rendered by the pass as `warehouse` from the facility's administered Letter Name and Form 482 payee hash (byte-for-byte; 29.4's
 * Loan Delivery letterhead), listing this loan's advance; 27.1 routes it to a human `officer{sm}` for signature (`issueBaileeLetter{op: sign}` is never the agent's). Once per advance.
 */
export async function renderBaileeLetter(ctx: StepContext): Promise<void> {
  const rec = ctx.rec; const closing = needClosing(rec); const now = ctx.now;
  if (closing.note_form !== "paper") return;
  const advance = rec.last("warehouse.advance.funded"); if (!advance) return;
  const advanceId = String(advance.payload["advance_id"]); if (baileeLetterOf(rec, advanceId)) return;
  const loanId = loanIdOf(rec); if (!loanId) return;   // the seller loan number is 30.2's; the letter follows the boarding
  const fid = String(advance.payload["facility_id"]); const facilityRow = rec.entities("warehouse_facilities", (d) => d["facility_id"] === fid).at(-1) ?? null;
  const fixture = fid === FACILITY_FIXTURE.facility_id ? FACILITY_FIXTURE : null;
  const letterName = S(facilityRow?.data["bailee_letter_name"]) ?? fixture?.bailee_letter_name ?? null; const payeeHash = S(facilityRow?.data["form_482_payee_hash"]) ?? fixture?.form_482_payee_hash ?? null;
  if (!letterName || !payeeHash) throw new RecordGap("warehouse_facilities.bailee_letter_name", `facility ${fid} carries no administered bailee letter name / Form 482 payee hash (27.1)`);
  const custodian = await custodianParty(rec); const parties = await partyFacts(rec, closing); const terms = loanTerms(rec);
  const consummated = rec.last("closing.consummated");
  await ctx.run({ process: "27.1", name: "issueBaileeLetter", actor: WAREHOUSE, input: { op: "render", facility_id: fid, letter: { bailee_letter_id: `BL-${rec.app.id.slice(0, 8)}`, facility_id: fid, custodian_party_id: custodian.id, letter_name: letterName, letter_date: civil(rec, now), loan_list: [{ advance_id: advanceId, seller_loan_number: await servicingLoanNumber(ctx, loanId), borrower_last_name: parties.borrower_names[0]?.split(" ").at(-1) ?? "", note_amount_cents: String(terms.loan_amount_cents.value), note_date: S(consummated?.payload["note_date"]) ?? closing.scheduled_note_date }], wire_instructions_hash: payeeHash, fnma_letter_type: "bailee", signature_kind: "esign" } },
    detail: { sources: { facility: facilityRow ? src("entity", `warehouse_facilities:${facilityRow.id}:${facilityRow.version}`, "27.1") : src("derived", `27.1 FACILITY_FIXTURE ${fid}`, "27.1"), advance: src("event", `warehouse.advance.funded:${advance.id}`, "27.1"), custodian: src("table", `parties:${custodian.id}`, "26.2"), note: terms.loan_amount_cents.source }, routed_to: "officer" } });
}

/**
 * The paper delivery (E-2-01 / C2-2-02): the endorsed original note and 27.1's issued bailee letter in the custodian package (29.4 `prepareCustodianPackage`), 27.1's shipment under the
 * letter (`SM_WH_BAILEE_LETTER_GATE`), the package tendered to the FAKE carrier (`scheduleShipment`) — `pre_positioned_at_fcc` when the wet note already sits with the custodian — then the
 * custodian's receipt and certification from the carrier's and custodian's scans (`trackShipment`). Waits on the `officer` until the letter is signed, on the custodian otherwise.
 */
export async function paperDelivery(ctx: StepContext, o: { loanId: string; deliveryId: string; submittedEventId: string }): Promise<StepOutcome> {
  let rec = ctx.rec; const closing = needClosing(rec); const now = ctx.now;
  const advance = rec.last("warehouse.advance.funded"); if (!advance) throw new RecordGap("warehouse.advance.funded", "27.1's advance is not on the record");
  const advanceId = String(advance.payload["advance_id"]);
  let letter = baileeLetterOf(rec, advanceId);
  if (!letter) { await renderBaileeLetter(ctx); rec = await ctx.refresh(); letter = baileeLetterOf(rec, advanceId); }
  if (!letter || !["issued", "acknowledged"].includes(String(letter.data["status"]))) return { wait: { status: "waiting_human", waiting_on: "officer", clocked: false } };
  const cert = rec.entities("custodian_certifications", (d) => d["delivery_id"] === o.deliveryId).at(-1) ?? null;
  if (!cert || !cert.data["package_shipped_at"]) {
    const noteDoc = rec.entities("closing_documents", (d) => d["kind"] === "note").at(-1); if (!noteDoc) throw new RecordGap("closing_documents{kind: note}", "26.1's paper note is not on the record");
    // the endorsement in blank is the partner's signing_officer's act (26.4 B8-3-04 / E-2-01): 26.4's `note_endorsements` row when the record carries one; else 26.4's gate is asserted — on a build stage whose FAKE reviewers fill `signing_officer` (35.7's owner decision) the FAKE signing officer's pre-executed allonge is recorded through 26.4 as that human actor, otherwise 26.4 routes the note to the endorsement desk and the row waits on the signing_officer; never the agent's signature
    let endorsement = rec.entities("note_endorsements").at(-1) ?? null;
    if (!endorsement) {
      // 26.4 rule 2 / B8-3-04 / E-2-01: the endorsement in blank is the partner's signing_officer's act — never the agent's (rule 4 HUMAN_ACTS_STAY_HUMAN). The pass asserts 26.4's gate once with the
      // note's facts: 26.4 routes the note to the endorsement desk (a `signing_officer` escalation, reason endorsement_cure, carrying the facts) and the row waits on that person. On a build stage whose
      // FAKE reviewers fill `signing_officer` (35.7's owner decision) the FAKE signing officer acts from that queue on FakeReviewers.tick — a pre-executed allonge recorded through 26.4 as that human actor.
      const parties = await partyFacts(rec, closing); const terms = loanTerms(rec); const consummated = rec.last("closing.consummated");
      const note = { borrower_names: parties.borrower_names, note_date: S(consummated?.payload["note_date"]) ?? closing.scheduled_note_date, note_amount_cents: String(terms.loan_amount_cents.value), property_address: parties.property_address, property_state: closing.state, partner_legal_name: parties.partner_legal_name };
      const open = await ctx.rt.db.query(`SELECT 1 FROM escalations WHERE application_id = $1 AND owner_role = 'signing_officer' AND completed_at IS NULL AND payload->>'reason' = 'endorsement_cure'`, [rec.app.id]);
      if (!open.length) await ctx.run({ process: "26.4", name: "registerMin", actor: POST_CLOSING, input: { op: "ensure_endorsement", note, closing_document_id: noteDoc.id }, detail: { sources: { note: src("entity", `closing_documents:${noteDoc.id}`, "26.1"), ...parties.sources }, route: "endorsement_desk" } });
      return { wait: { status: "waiting_human", waiting_on: "signing_officer", clocked: false } };
    }
    const signingOfficer = S(endorsement?.data["signing_officer_party_id"]);
    if (!signingOfficer) throw new RecordGap("note_endorsements", "no endorsement by the partner's signing_officer on the record (26.4)");
    const prePositioned = rec.has("warehouse.note.received"); const custodyMode = prePositioned ? "pre_positioned_at_fcc" : "shipped_package";
    const pkg = await ctx.run<Row>({ process: "29.4", name: "prepareCustodianPackage", actor: SECONDARY, scope: { loanId: o.loanId }, input: { delivery_id: o.deliveryId, note_document_id: noteDoc.id, endorsement_signing_officer: signingOfficer, custody_mode: custodyMode }, detail: { sources: { note: src("entity", `closing_documents:${noteDoc.id}`, "26.1"), letter: src("entity", `bailee_letters:${letter.id}`, "27.1"), endorsement: src("entity", `note_endorsements:${endorsement.id}`, "26.4"), ...(prePositioned ? { note_received: src("event", `warehouse.note.received:${rec.last("warehouse.note.received")!.id}`, "27.1") } : {}) } } });
    if (pkg["complete"] === false) return { hold: { reason: "gate_closed", gate: "E_2_01_CUSTODIAN_PACKAGE", detail: { missing: pkg["missing"] ?? [] } } };
    const shipmentId = `SHP-${rec.app.id.slice(0, 8)}`; const tracking = `TRK-${rec.app.id.slice(0, 8)}`; const custodian = await custodianParty(rec);
    if (!rec.has("warehouse.note.shipment_requested", (p) => p["shipment_id"] === shipmentId)) { await ctx.run({ process: "27.1", name: "trackCollateral", actor: WAREHOUSE, input: { op: "shipment_request", advance_id: advanceId, facility_id: String(advance.payload["facility_id"]), shipment_id: shipmentId, custodian_party_id: custodian.id }, detail: { sources: { letter: src("entity", `bailee_letters:${letter.id}`, "27.1") } } }); rec = await ctx.refresh(); }
    if (!rec.has("warehouse.note.shipment_released", (p) => p["shipment_id"] === shipmentId)) { await ctx.run({ process: "27.1", name: "trackCollateral", actor: WAREHOUSE, input: { op: "shipment_release", advance_id: advanceId, facility_id: String(advance.payload["facility_id"]), shipment_id: shipmentId, bailee_letter_id: letter.id, tracking }, detail: { sources: { letter: src("entity", `bailee_letters:${letter.id}`, "27.1") }, gate: "SM_WH_BAILEE_LETTER_GATE" } }); rec = await ctx.refresh(); }
    const docs = ((pkg["documents"] as Row[] | undefined) ?? []).map((d) => S(d["document_id"])).filter((x): x is string => x !== null);
    await ctx.run({ process: "29.4", name: "scheduleShipment", actor: SECONDARY, scope: { loanId: o.loanId }, input: { delivery_id: o.deliveryId, carrier: ctx.fakes.carrier.vendorName, tracking_number: tracking, tendered_at: now, first_morning_service: true, package_document_ids: docs, custody_mode: custodyMode, at: now }, detail: { sources: { submitted: src("event", `delivery.submitted:${o.submittedEventId}`, "29.4"), package: src("derived", "29.4 prepareCustodianPackage (this pass)", "29.4"), release: src("event", `warehouse.note.shipment_released:${rec.last("warehouse.note.shipment_released")?.id ?? ""}`, "27.1") }, fake: ctx.fakes.carrier.vendorName } });
    return { wait: { status: "waiting_vendor", waiting_on: "custodian", clocked: true } };
  }
  const scans = ctx.fakes.carrier.scans(o.deliveryId, String(cert.data["package_shipped_at"]));
  if (!cert.data["received_at_custodian"] && now >= scans.received_at) {
    await ctx.run({ process: "29.4", name: "trackShipment", actor: SECONDARY, scope: { loanId: o.loanId }, input: { op: "received", delivery_id: o.deliveryId, received_at: scans.received_at, at: scans.received_at }, detail: { sources: { scan: src("platform", `${ctx.fakes.carrier.vendorName} delivery scan ${String(cert.data["tracking_number"])}`, "35.6") } } });
    rec = await ctx.refresh();
  }
  if (!rec.has("custody.certified", (p) => p["certified_on"] !== undefined) && now >= scans.certified_at) {
    const notice = await storeDocument(ctx.rt.db, { kind: "custodian_certification_notice", application_id: rec.app.id, loan_id: o.loanId, text: JSON.stringify({ delivery_id: o.deliveryId, certified_at: scans.certified_at, certification_kind: "certified", bailee_letter_name_used: letter.data["letter_name"], custodian: ctx.fakes.carrier.custodianName }), retention_class: "life_of_loan_plus_4y", source: `${ctx.fakes.carrier.custodianName} certification notice (FAKE custodian)`, now, source_channel: "vendor_delivery" });
    await ctx.run({ process: "29.4", name: "trackShipment", actor: SECONDARY, scope: { loanId: o.loanId }, input: { op: "certified", delivery_id: o.deliveryId, certified_at: scans.certified_at, certification_kind: "certified", bailee_validation: "passed", bailee_letter_name_used: String(letter.data["letter_name"]), notice_document_id: notice, at: scans.certified_at }, detail: { sources: { notice: src("table", `documents:${notice}`, "35.2"), letter: src("entity", `bailee_letters:${letter.id}`, "27.1") }, fake: ctx.fakes.carrier.custodianName } });
    return {};
  }
  return { wait: { status: "waiting_vendor", waiting_on: "custodian", clocked: true } };
}
