/**
 * §24.4 process-owned tools — bus tools for 24.4 defined with `defineTools("24.4", "title-closing", defs)` from
 * ../tools.ts. Every tool string must be one spec/registry/agents.json names for 24.4; src/app/tools.test.ts refuses
 * the rest. Spread by ./index.ts.
 *
 * The `title-closing` agent (spec "AI agent design"): orderTitle, parseCommitment, classifyException,
 * computeRequiredEndorsements, openCurative, requestUnderwriterDeletion, requestDateDown, vetSettlementAgent,
 * lookupAltaRegistry, verifyWireInstructions, placeCallback, requestPayoff, parsePayoffStatement, computePayoffAtDate,
 * decideEscrowTreatment, requestSubordination, checkSubordinateTerms, reviewTrust, reviewPOA, requestCPL, evaluateGates,
 * writeDecision. Guardrails encode the paragraph: never accept an impediment outside B7-2-05's minor list without the
 * partner officer's indemnity acknowledgment; never release or alter wire instructions; never treat a non-ALTA-2021
 * policy as acceptable; never proceed with a POA cash-out; never use an AOL where barred; never skip the callback;
 * never compute a funding payoff from a stale statement; never disable a gate. State lives in the entity store
 * (`title_orders`, `title_curative_items`, `settlement_agents`, `wire_verifications`, `payoff_demands`, `subordinations`,
 * `trust_reviews`, `poa_reviews`); events go through ops-24-4.ts so the timers arm and close; the title / wire-verification /
 * ALTA Registry / state DOI vendors are runtime services (`title`, `wireVerification`, `altaRegistry`, `stateDoi` — ports
 * with fakes in ops-24-4.ts); 21.4's fee gate precedes the order; the same-servicer payoff goes through 16.1.
 */
import { defineTools, compute, decision, service, never, needsRole, str, num, flag, cents, PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { evaluateGate } from "../evaluators.ts";
import { AGENT_24_4, RULE_SET_VERSION_24_4, GATES_24_4, orderTitleFeeGate, placeTitleOrder, parseCommitment, classifyException, computeRequiredEndorsements, missingEndorsements, endorsementFamily, endorsementClears, openCurative, clearCurative, transitionTitleOrder, clearanceCheck, commitmentDatedownGate,
  vetSettlementAgent, verifyWireInstructions, releaseWireBlock, cplBeforeFundingGate, requestPayoff, parsePayoffStatement, computePayoffAtDate, payoffStaleness, decideEscrowTreatment, helocRatios, checkSubordinateTerms, reviewTrust, reviewPOA, trustPoaReviewGate, evaluateAolPath, tx50a6TitleCheck, cemaNewMoney, classifyTaxCertificate, evaluateGates as evalGates, dateOf,
  recordCommitmentReceived, recordOrderRejected, recordExceptionClassified, recordEndorsementsRequired, recordCurativeOpened, recordCurativeCleared, recordOrderStatus, recordDatedownReceived, recordAolDecision, recordAgentVetted, recordWireVerification, recordCplReceived, recordPayoffStatement, recordPayoffStale, recordEscrowTreatment, recordSubordinationRequested, recordSubordinationAgreement, recordTrustReviewed, recordPoaReviewed, recordVestingReviewsCompleted,
  type EventCtx, type TitleOrderStatus, type CurativeItem, type WireVerification, type ScheduleItem, type PropertyTitleFacts, type CommitmentInput, type AgentVettingInput, type WireVerificationInput, type PayoffStatementInput, type SubordinateTerms, type TrustReviewInput, type PoaReviewInput, type AolInput, type TaxInstallment, type GateOutcome, type CallbackSource,
  type TitleVendorPort, type WireVerificationPort, type AltaRegistryPort, type StateDoiPort } from "../../domain/property/ops-24-4.ts";

/** Missing-input refusals are RangeErrors (never TypeErrors) — src/app/tools.test.ts executes every tool with `{}`. */
const need = (i: ToolInput, ...keys: string[]): void => { const missing = keys.filter((k) => i[k] === undefined || i[k] === null || i[k] === ""); if (missing.length) throw new RangeError(`24.4 tool needs ${missing.join(", ")}`); };
const appOf = (i: ToolInput, ctx: CommandContext): string => { const a = (i.application_id as string | undefined) ?? ctx.applicationId; if (!a) throw new RangeError("24.4 tool needs application_id (every 24.4 event carries it so the timers arm under origination context)"); return a; };
const ectx = (i: ToolInput, ctx: CommandContext): EventCtx => ({ application_id: appOf(i, ctx), loan_id: (i.loan_id as string | undefined) ?? (ctx.loanId || null), actor: ctx.actor, at: typeof i.at === "string" ? i.at : ctx.now });
const dateIn = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (typeof i[k] === "string" && i[k] !== "" ? D(str(i, k)) : null);
const optStr = (i: ToolInput, k: string): string | null => (typeof i[k] === "string" && i[k] !== "" ? (i[k] as string) : null);
const optCents = (i: ToolInput, k: string): bigint | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : cents(i[k]));
const obj = <T extends object>(i: ToolInput, k: string): T => { const v = i[k]; if (!v || typeof v !== "object" || Array.isArray(v)) throw new RangeError(`24.4 tool needs ${k} {…}`); return v as T; };
const optList = <T>(i: ToolInput, k: string): T[] => (Array.isArray(i[k]) ? (i[k] as T[]) : []);
const at = (i: ToolInput, ctx: CommandContext): string => (typeof i.at === "string" ? i.at : ctx.now);
const persist = (rt: ToolRuntime, ctx: CommandContext, kind: string, id: string, data: Record<string, unknown>) => rt.store.put(kind, id, data, ctx.actor, ctx.now);
const orderRow = (rt: ToolRuntime, id: string): Record<string, unknown> => { const r = rt.store.get("title_orders", id); if (!r) throw new RangeError(`24.4: no title_orders row ${id} — orderTitle first`); return r.data; };
const latestOrder = (rt: ToolRuntime, app: string): Record<string, unknown> | null => rt.store.list("title_orders", (d) => d.application_id === app && d.order_type === "commitment" && d.status !== "cancelled").map((r) => r.data).at(-1) ?? null;
const openBlocking = (rt: ToolRuntime, orderId: string): CurativeItem[] => rt.store.list("title_curative_items", (d) => d.title_order_id === orderId && d.cleared_at === null && d.blocks_consummation === true).map((r) => r.data as unknown as CurativeItem);
const setStatus = (rt: ToolRuntime, ctx: CommandContext, c: EventCtx, order: Record<string, unknown>, to: TitleOrderStatus): Record<string, unknown> => {
  const from = order.status as TitleOrderStatus; if (from === to) return order;
  recordOrderStatus(ctx.events, c, { order_id: String(order.id), from, status: to, at: c.at ?? ctx.now });
  return persist(rt, ctx, "title_orders", String(order.id), { ...order, status: transitionTitleOrder(from, to) }).data;
};
/** Vendor ports: optional at runtime (portal / e-mail fallback per Integrations) — a missing service never blocks the rule. */
const optService = <T>(rt: ToolRuntime, name: string): T | null => { try { return service<T>(rt, name); } catch (e) { if (e instanceof PortUnavailable) return null; throw e; } };
const EO_ETC = (i: ToolInput): AgentVettingInput => ({ party_id: str(i, "party_id"), agent_type: str(i, "agent_type") as AgentVettingInput["agent_type"], state: str(i, "state"), property_state: str(i, "property_state"), license_active: flag(i, "license_active"), eo_policy_limit_cents: cents(i.eo_policy_limit_cents), eo_expires_on: dateIn(i, "eo_expires_on"), fidelity_limit_cents: cents(i.fidelity_limit_cents), alta_registry_id: optStr(i, "alta_registry_id"), underwriter_confirmed_by: optStr(i, "underwriter_confirmed_by"), best_practices_attestation_at: optDate(i, "best_practices_attestation_at"), wire_instructions_on_letterhead: flag(i, "wire_instructions_on_letterhead"), cpl_available: flag(i, "cpl_available"), underwriter_callback_number_verified: flag(i, "underwriter_callback_number_verified"), referral_consideration: flag(i, "referral_consideration"), as_of: optDate(i, "as_of") ?? dateOf(str(i, "at") || "2026-01-01") });
const GATE_REFS: Record<string, string> = { FNMA_B7_2_01_TITLE_EVIDENCE_GATE: "24.4.titleEvidenceGate", SM_TITLE_COMMITMENT_DATEDOWN_GATE: "24.4.commitmentDatedownGate", SM_CPL_BEFORE_FUNDING_GATE: "24.4.cplBeforeFundingGate", SM_WIRE_VERIFICATION_GATE: "24.4.wireVerificationGate", SM_PAYOFF_GOOD_THROUGH_GATE: "24.4.payoffGoodThroughGate", FNMA_B2_1_2_04_RESUBORDINATION_GATE: "24.4.resubordinationGate", SM_SETTLEMENT_AGENT_VETTING_GATE: "24.4.settlementAgentVettingGate", SM_TRUST_POA_REVIEW_GATE: "24.4.trustPoaReviewGate" };
/** Gate facts assembled from the entity store for one application (the ops console's "manual gate evaluation" sees the same facts). */
function assembleFacts(rt: ToolRuntime, app: string, i: ToolInput, ctx: CommandContext): Record<string, unknown> {
  const order = latestOrder(rt, app);
  const agent = order ? rt.store.get("settlement_agents", String(order.settlement_agent_party_id))?.data ?? null : null;
  const wire = rt.store.list("wire_verifications", (d) => d.application_id === app && d.purpose === (i.wire_purpose ?? "closing_funds")).map((r) => r.data).at(-1) ?? null;
  const payoffs = rt.store.list("payoff_demands", (d) => d.application_id === app).map((r) => ({ liability_id: String(r.data.liability_id), status: String(r.data.status), good_through_date: (r.data.good_through_date as PlainDate | null) ?? null }));
  const subs = rt.store.list("subordinations", (d) => d.application_id === app).map((r) => ({ liability_id: String(r.data.liability_id), status: String(r.data.status), recordable: r.data.recordable === true, statutory_position_preserved: r.data.statutory_position_preserved === true }));
  const trusts = rt.store.list("trust_reviews", (d) => d.application_id === app).map((r) => ({ borrower_id: String(r.data.borrower_id), result: String(r.data.result) }));
  const poas = rt.store.list("poa_reviews", (d) => d.application_id === app).map((r) => ({ borrower_id: String(r.data.borrower_id), result: String(r.data.result) }));
  const cpl = order ? (order.cpl as Record<string, unknown> | undefined) ?? null : null;
  const facts: Record<string, unknown> = { application_id: app, application_ref: app, as_of: at(i, ctx), now: at(i, ctx), consummation_on: i.consummation_on ?? order?.closing_date ?? null, disbursement_date: i.disbursement_date ?? i.funding_date ?? null, funding_date: i.funding_date ?? i.disbursement_date ?? null, partner_name: i.partner_name ?? "Partner",
    ...(order ? { policy_form: order.policy_form ?? "", required_endorsements: order.required_endorsements ?? [], issued_endorsements: order.issued_endorsements ?? [], committed_endorsements: order.committed_endorsements ?? [], policy_amount_cents: order.policy_amount_cents ?? 0n, note_amount_cents: order.note_amount_cents ?? 0n, proposed_insured_text: order.proposed_insured_text ?? "", creditors_rights_exclusion: order.creditors_rights_exclusion === true, t42_deletions: order.t42_deletions ?? [], aol: order.aol === true, aol_ok: order.aol_ok === true, order_status: order.status, state_promulgated_equivalent: order.state_promulgated_equivalent === true,
      commitment_effective_date: order.commitment_effective_date ?? null, datedown_effective_date: order.datedown_effective_date ?? null, underwriter_party_id: order.underwriter_party_id ?? null, settlement_agent_party_id: order.settlement_agent_party_id ?? null } : {}),
    ...(cpl ? { cpl_underwriter_party_id: cpl.underwriter_party_id ?? null, cpl_agent_party_id: cpl.agent_party_id ?? null, addressees: cpl.addressees ?? [], transaction_ref: cpl.transaction_ref ?? null, cpl_date: cpl.cpl_date ?? null, validity_days: cpl.validity_days ?? null } : {}),
    ...(agent ? { vetting_status: agent.vetting_status, vetting_expires_on: agent.vetting_expires_on } : {}),
    ...(wire ? { verified_at: wire.verified_at, change_detected_at: wire.change_detected_at, blocks_disbursement: wire.blocks_disbursement, callback_number_source: wire.callback_number_source } : {}),
    payoffs, subordinations: subs, trust_reviews: trusts, poa_reviews: poas };
  return { ...facts, ...((i.facts as Record<string, unknown> | undefined) ?? {}) };
}
const outcome = (code: string, facts: Record<string, unknown>): GateOutcome => { const r = evaluateGate(GATE_REFS[code]!, facts); return { open: r.open, reason: r.reason ?? null, reasons: r.open ? [] : [r.reason ?? "closed"] }; };
/** After every trust / POA review: the application-wide verdict closes SM_TRUST_POA_REVIEW_GATE when everything is eligible. */
const vestingVerdict = (rt: ToolRuntime, ctx: CommandContext, c: EventCtx, app: string) => recordVestingReviewsCompleted(ctx.events, c, trustPoaReviewGate({ trust_reviews: rt.store.list("trust_reviews", (d) => d.application_id === app).map((r) => ({ borrower_id: String(r.data.borrower_id), result: String(r.data.result) })), poa_reviews: rt.store.list("poa_reviews", (d) => d.application_id === app).map((r) => ({ borrower_id: String(r.data.borrower_id), result: String(r.data.result) })) }));
const IMPEDIMENT_OFFICER = needsRole("B7_2_05_IMPEDIMENT_INDEMNITY_OFFICER", "24.4 guardrails: never accept an impediment outside B7-2-05's minor list without the partner officer's indemnity acknowledgment", (i) => i.accept_impediment === true || i.resolution === "indemnity_accepted_by_officer", ["officer"], "an impediment outside the minor list is accepted only by the partner officer with the B7-2-05 indemnity recorded in agent_decisions");
const NO_WIRE_ALTERATION = never("WIRE_INSTRUCTIONS_NEVER_ALTERED", "24.4 guardrails: never release or alter wire instructions", (i) => i.alter_instructions === true || i.override_routing_number !== undefined || i.override_account_number !== undefined || i.edit_instructions !== undefined, "wire instructions are verified as received from the agent's/servicer's registered record; the platform never edits or substitutes them");
const NO_CALLBACK_SKIP = never("WIRE_CALLBACK_NEVER_SKIPPED", "24.4 guardrails: never skip the callback", (i) => i.skip_callback === true || (typeof i.callback === "object" && i.callback !== null && (i.callback as { number_source?: string }).number_source === "email"), "every verification includes an SM-initiated callback to a number from the ALTA Registry, the underwriter or a prior verified record — never from the e-mail carrying the instructions");

export const TOOLS_24_4: readonly ToolDef[] = defineTools("24.4", "title-closing", [
  // ---------------------------------------------------------------- order (21.4 fee gate first)
  { name: "orderTitle", kind: "act", handler: compute(async (i, ctx, rt) => {
    need(i, "settlement_agent_party_id", "apn", "note_amount_cents", "proposed_insured_text");
    const app = appOf(i, ctx); const c = ectx(i, ctx);
    let feeCheckId: string | null = null; let fee: ReturnType<typeof orderTitleFeeGate> | null = null;
    if (i.fee_gate && typeof i.fee_gate === "object") {
      const fg = i.fee_gate as { amount_cents: unknown; le_effective_receipt_date?: string | null; intent?: Parameters<typeof orderTitleFeeGate>[1]["intent"]; fee_item_id?: string | null };
      fee = orderTitleFeeGate(ctx.events, { application_id: app, amount_cents: cents(fg.amount_cents), checked_at: at(i, ctx), le_effective_receipt_date: fg.le_effective_receipt_date ? D(fg.le_effective_receipt_date) : null, intent: fg.intent ?? null, fee_item_id: fg.fee_item_id ?? null });
      feeCheckId = fee.check.check_id;
      if (!fee.open) throw new RangeError(`order_title refused by 21.4's fee gate (${fee.check.result}): the title fee cannot be imposed before LE receipt and intent to proceed`);
    }
    const { order, events } = placeTitleOrder(ctx.events, c, { application_id: app, order_type: (optStr(i, "order_type") ?? "commitment") as "commitment", settlement_agent_party_id: str(i, "settlement_agent_party_id"), underwriter_party_id: optStr(i, "underwriter_party_id"), apn: str(i, "apn"), proposed_insured_text: str(i, "proposed_insured_text"), note_amount_cents: cents(i.note_amount_cents), requested_endorsements: optList<string>(i, "requested_endorsements").length ? optList<string>(i, "requested_endorsements") : computeRequiredEndorsements((i.property as PropertyTitleFacts | undefined) ?? {}), closing_date: optDate(i, "closing_date"), ordered_at: at(i, ctx) }, feeCheckId);
    const vendor = optService<TitleVendorPort>(rt, "title"); const ack = vendor ? await vendor.order({ order_id: order.id, application_id: app, settlement_agent_party_id: order.settlement_agent_party_id, payload: { apn: order.apn, proposed_insured_text: order.proposed_insured_text, note_amount_cents: order.note_amount_cents.toString(), requested_endorsements: order.requested_endorsements, closing_date: order.closing_date } }) : null;
    persist(rt, ctx, "title_orders", order.id, { ...order, vendor_ref: ack?.vendor_ref ?? null, required_endorsements: [...order.requested_endorsements], issued_endorsements: [], committed_endorsements: [], policy_form: null, policy_amount_cents: 0n, cpl: null });
    return { order, fee_gate: fee ? { check_id: fee.check.check_id, result: fee.check.result } : null, vendor_ack: ack, events: events.map((e) => e.type) };
  }), guardrails: [never("PROPOSED_INSURED_NEVER_MERS", "B7-2-03: Under no circumstances may MERS be named as the insured of a title policy", (i) => typeof i.proposed_insured_text === "string" && /\bMERS\b/i.test(i.proposed_insured_text), "the proposed insured is the partner, its successors and/or assigns"), never("RESPA_8_NO_CONDITIONING_ON_AGENT", "§1024.14(b) / §1024.15: SM may recommend a vetted agent but must let the borrower shop and never condition anything on the choice", (i) => i.require_panel_agent === true || i.referral_fee_cents !== undefined, "no thing of value flows for referrals; the borrower may choose any agent meeting the vetting standard")] },
  // ---------------------------------------------------------------- commitment intake (T1–T4, T13)
  { name: "parseCommitment", kind: "act", handler: compute(async (i, ctx, rt) => {
    need(i, "order_id", "commitment_number", "commitment_effective_date", "underwriter_party_id", "underwriter_state", "policy_form", "policy_amount_cents", "legal_description", "apn");
    const app = appOf(i, ctx); const c = ectx(i, ctx); const order = orderRow(rt, str(i, "order_id"));
    const doi = optService<StateDoiPort>(rt, "stateDoi"); const licensed = typeof i.doi_licensed === "boolean" ? i.doi_licensed : doi ? await doi.insurerLicensed(str(i, "underwriter_party_id"), str(i, "underwriter_state")) : null;
    const input: CommitmentInput = { application_id: app, order_id: str(i, "order_id"), commitment_number: str(i, "commitment_number"), commitment_effective_date: dateIn(i, "commitment_effective_date"), received_at: at(i, ctx), underwriter_party_id: str(i, "underwriter_party_id"), underwriter_state: str(i, "underwriter_state"), doi_licensed: licensed, strength_basis: optStr(i, "strength_basis"),
      proposed_insured_text: optStr(i, "proposed_insured_text") ?? String(order.proposed_insured_text ?? ""), policy_form: str(i, "policy_form"), policy_amount_cents: cents(i.policy_amount_cents), note_amount_cents: optCents(i, "note_amount_cents") ?? cents(order.note_amount_cents), vesting: (i.vesting as CommitmentInput["vesting"] | undefined) ?? { names: [], tenancy: "unknown", trust: false, estate: "fee_simple" }, legal_description: str(i, "legal_description"), apn: str(i, "apn"),
      schedule_b1_requirements: optList<string>(i, "schedule_b1_requirements"), schedule_b2_exceptions: optList<ScheduleItem>(i, "schedule_b2_exceptions"), endorsements_committed: optList<string>(i, "endorsements_committed"), property: (i.property as PropertyTitleFacts | undefined) ?? {}, appraisal_legal_description: optStr(i, "appraisal_legal_description") };
    const p = parseCommitment(input);
    if (!p.accepted) {
      recordOrderRejected(ctx.events, c, { order_id: input.order_id, reason: p.rejection_reason!, action: p.action, underwriter_party_id: input.underwriter_party_id });
      rt.escalations.open({ kind: "settlement_agent", loanId: ctx.loanId, payload: { application_id: app, order_id: input.order_id, reason: p.rejection_reason, action: p.action, underwriter_party_id: input.underwriter_party_id } }, ctx.actor);
      persist(rt, ctx, "title_orders", input.order_id, { ...order, underwriter_party_id: input.underwriter_party_id, underwriter_license_state_ok: false, commitment_number: input.commitment_number, rejection_reason: p.rejection_reason });
      return { accepted: false, rejection_reason: p.rejection_reason, action: p.action, escalated_to: "settlement_agent", required_endorsements: p.required_endorsements };
    }
    let row = order.status === "ordered" ? setStatus(rt, ctx, c, order, "commitment_received") : order;
    // a re-issued commitment / corrected pro forma supersedes the Schedule B-I items the earlier version raised (form, endorsements): those no longer reproduced are cleared as not_required
    const superseded = rt.store.list("title_curative_items", (d) => d.title_order_id === input.order_id && d.cleared_at === null && d.source === "schedule_b1").map((r) => r.data as unknown as CurativeItem);
    recordCommitmentReceived(ctx.events, c, { order_id: input.order_id, commitment_number: input.commitment_number, commitment_effective_date: input.commitment_effective_date, apn: input.apn, policy_form: input.policy_form, policy_amount_cents: input.policy_amount_cents, vesting: input.vesting, legal_description_hash: p.legal_description_hash, underwriter_party_id: input.underwriter_party_id, required_endorsements: p.required_endorsements, missing_endorsements: p.missing_endorsements, status: p.status, received_at: input.received_at });
    for (const x of p.exceptions) recordExceptionClassified(ctx.events, c, { order_id: input.order_id, text: x.text, kind: x.kind, classification: x.classification, blocking: x.blocking, rule: x.rule });
    recordEndorsementsRequired(ctx.events, c, { order_id: input.order_id, required_endorsements: p.required_endorsements, missing_endorsements: p.missing_endorsements });
    const opened: CurativeItem[] = [];
    const open = (kind: string, source: string, owner: CurativeItem["owner"], description: string, amount?: bigint | null) => { const item = openCurative({ title_order_id: input.order_id, kind, source, owner, description, opened_at: input.received_at, amount_cents: amount ?? null }); persist(rt, ctx, "title_curative_items", item.id, item as unknown as Record<string, unknown>); recordCurativeOpened(ctx.events, c, item); opened.push(item); };
    for (const m of p.missing_endorsements) open("other", "schedule_b1", "settlement_agent", `endorsement ${endorsementFamily(m)} required (B7-2-03/-04) — issue or commit on the pro forma`);
    if (!p.policy_form.ok) open("other", "schedule_b1", "settlement_agent", `policy form ${p.policy_form.proposed}: ${p.policy_form.reason} — the 2021 ALTA Loan Policy is required (B7-2-03)`);
    for (const x of p.exceptions) if (x.blocking && x.curative_kind) open(x.curative_kind, "schedule_b2", x.classification === "to_be_paid" ? "settlement_agent" : "title_underwriter", `${x.text} — ${x.rule}`, undefined);
    if (p.legal_description_matches_appraisal === false) open("legal_description_mismatch", "schedule_b1", "title_underwriter", "Schedule A legal description differs from the appraisal/deed — 24.1/24.3 notified; underwriter corrects Schedule A");
    const tax = Array.isArray(i.tax_certificate) && optDate(i, "consummation_on") ? classifyTaxCertificate({ installments: optList<TaxInstallment>(i, "tax_certificate"), consummation_on: optDate(i, "consummation_on")! }) : null;
    if (tax) for (const t of tax.items) if (t.blocking) open("tax_delinquent", "tax_cert", "settlement_agent", `${t.label}: ${t.reason}`);
    for (const old of superseded) if (!opened.some((n) => n.description === old.description)) { const cleared = clearCurative(old, { resolution: "not_required", evidence_document_id: optStr(i, "commitment_document_id"), cleared_at: input.received_at }); persist(rt, ctx, "title_curative_items", cleared.id, cleared as unknown as Record<string, unknown>); recordCurativeCleared(ctx.events, c, cleared); }
    row = persist(rt, ctx, "title_orders", input.order_id, { ...row, underwriter_party_id: input.underwriter_party_id, underwriter_license_state_ok: true, underwriter_strength_basis: input.strength_basis, commitment_number: input.commitment_number, commitment_effective_date: input.commitment_effective_date, commitment_received_at: input.received_at, proposed_insured_text: input.proposed_insured_text, policy_form: input.policy_form, policy_amount_cents: input.policy_amount_cents, vesting: input.vesting, legal_description_hash: p.legal_description_hash, apn: input.apn,
      schedule_b1_requirements: [...input.schedule_b1_requirements], schedule_b2_exceptions: p.exceptions, required_endorsements: [...p.required_endorsements], committed_endorsements: [...input.endorsements_committed], creditors_rights_exclusion: flag(i, "creditors_rights_exclusion"), t42_deletions: optList<string>(i, "t42_deletions"), state_promulgated_equivalent: input.property.state_promulgated_forms === true }).data;
    row = setStatus(rt, ctx, c, row, openBlocking(rt, input.order_id).length ? "curative_open" : "reviewed");
    return { accepted: true, status: row.status, required_endorsements: p.required_endorsements, missing_endorsements: p.missing_endorsements, policy_form: p.policy_form, exceptions: p.exceptions, legal_description_hash: p.legal_description_hash, legal_description_matches_appraisal: p.legal_description_matches_appraisal, curative_opened: opened, tax_certificate: tax, apn: input.apn };
  }), guardrails: [never("ALTA_2021_FORM_REQUIRED", "24.4 guardrails: never treat a non-ALTA-2021 policy as acceptable for an in-scope loan", (i) => i.accept_non_2021_form === true, "every loan in scope was originated after Jan 1, 2024 — B7-2-03 requires the 2021 ALTA Loan Policy (or a short form / state form with equivalent coverage)")] },
  { name: "classifyException", kind: "act", handler: compute((i, ctx) => {
    need(i, "kind", "text");
    const r = classifyException({ ...(i as unknown as ScheduleItem), amount_cents: optCents(i, "amount_cents") ?? undefined } as ScheduleItem);
    if (typeof i.order_id === "string" && (i.application_id || ctx.applicationId)) recordExceptionClassified(ctx.events, ectx(i, ctx), { order_id: str(i, "order_id"), text: str(i, "text"), kind: str(i, "kind"), ...r });
    return { ...r, rule_set_version: RULE_SET_VERSION_24_4 };
  }), guardrails: [IMPEDIMENT_OFFICER] },
  { name: "computeRequiredEndorsements", kind: "act", handler: compute((i, ctx) => {
    need(i, "property");
    const p = obj<PropertyTitleFacts>(i, "property"); const required = computeRequiredEndorsements(p); const missing = missingEndorsements(required, [...optList<string>(i, "issued_endorsements"), ...optList<string>(i, "committed_endorsements")]);
    if (typeof i.order_id === "string" && (i.application_id || ctx.applicationId)) recordEndorsementsRequired(ctx.events, ectx(i, ctx), { order_id: str(i, "order_id"), required_endorsements: required, missing_endorsements: missing });
    const tx = p.tx_50a6 ? tx50a6TitleCheck({ endorsements: [...optList<string>(i, "issued_endorsements"), ...optList<string>(i, "committed_endorsements")], t42_deleted_paragraphs: optList<string>(i, "t42_deleted_paragraphs"), ...(optStr(i, "closing_type") ? { closing_type: optStr(i, "closing_type")! } : {}) }) : null;
    return { required_endorsements: required, missing_endorsements: missing, gate_passes: missing.length === 0 && (tx?.open ?? true), tx_50a6: tx };
  }) },
  // ---------------------------------------------------------------- curative
  { name: "openCurative", kind: "act", handler: compute((i, ctx, rt) => {
    const c = ectx(i, ctx);
    if (i.op === "clear") {
      need(i, "curative_id", "resolution");
      const rec = rt.store.get("title_curative_items", str(i, "curative_id")); if (!rec) throw new RangeError(`no title_curative_items row ${str(i, "curative_id")}`);
      const item = rec.data as unknown as CurativeItem;
      if (typeof i.issued_endorsement === "string" && typeof i.required_endorsement === "string" && !endorsementClears(str(i, "required_endorsement"), str(i, "issued_endorsement"))) throw new RangeError(`${str(i, "issued_endorsement")} does not satisfy ${str(i, "required_endorsement")} (B7-2-04)`);
      const cleared = clearCurative(item, { resolution: str(i, "resolution"), evidence_document_id: optStr(i, "evidence_document_id"), cleared_at: at(i, ctx) });
      persist(rt, ctx, "title_curative_items", cleared.id, cleared as unknown as Record<string, unknown>); recordCurativeCleared(ctx.events, c, cleared);
      const order = rt.store.get("title_orders", cleared.title_order_id)?.data; let status: unknown = order?.status ?? null;
      if (order && i.issued_endorsement) status = persist(rt, ctx, "title_orders", cleared.title_order_id, { ...order, issued_endorsements: [...optList<string>(order as ToolInput, "issued_endorsements"), str(i, "issued_endorsement")] }).data.status;
      if (order && order.status === "curative_open" && openBlocking(rt, cleared.title_order_id).length === 0) status = setStatus(rt, ctx, c, rt.store.get("title_orders", cleared.title_order_id)!.data, "reviewed").status;
      return { item: cleared, open_blocking_items: openBlocking(rt, cleared.title_order_id).length, order_status: status };
    }
    need(i, "title_order_id", "kind", "source", "owner", "description");
    const item = openCurative({ title_order_id: str(i, "title_order_id"), kind: str(i, "kind"), source: str(i, "source"), owner: str(i, "owner") as CurativeItem["owner"], description: str(i, "description"), opened_at: at(i, ctx), amount_cents: optCents(i, "amount_cents"), blocks_consummation: i.blocks_consummation === undefined ? true : flag(i, "blocks_consummation") });
    persist(rt, ctx, "title_curative_items", item.id, item as unknown as Record<string, unknown>); recordCurativeOpened(ctx.events, c, item);
    const order = rt.store.get("title_orders", item.title_order_id)?.data; if (order && item.blocks_consummation && (order.status === "reviewed" || order.status === "cleared" || order.status === "dated_down")) setStatus(rt, ctx, c, order, "curative_open");
    if (item.owner === "settlement_agent") rt.escalations.open({ kind: "settlement_agent", loanId: ctx.loanId, payload: { application_id: c.application_id, curative_id: item.id, kind: item.kind, description: item.description, follow_up: "2 business_days_creditor" } }, ctx.actor);
    return { item, addressed_to: item.owner };
  }), guardrails: [IMPEDIMENT_OFFICER] },
  { name: "requestUnderwriterDeletion", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "title_order_id", "curative_id", "exception_text");
    const c = ectx(i, ctx);
    const e = ctx.events.append({ type: "title.underwriter_deletion.requested", applicationId: c.application_id, actor: ctx.actor, payload: { application_id: c.application_id, title_order_id: str(i, "title_order_id"), curative_id: str(i, "curative_id"), exception_text: str(i, "exception_text"), requested_of: "title_underwriter", options: ["delete", "affirmative_coverage", "endorsement"], requested_at: at(i, ctx) } });
    rt.escalations.open({ kind: "settlement_agent", loanId: ctx.loanId, payload: { application_id: c.application_id, curative_id: str(i, "curative_id"), request: "underwriter deletion / affirmative coverage", exception_text: str(i, "exception_text") } }, ctx.actor);
    return { requested: true, event: e.type, awaiting: "underwriter deletion, affirmative coverage or endorsement (else officer indemnity under B7-2-05)" };
  }), guardrails: [IMPEDIMENT_OFFICER] },
  { name: "requestDateDown", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "order_id");
    const c = ectx(i, ctx); const order = orderRow(rt, str(i, "order_id"));
    if (i.op === "receive") {
      need(i, "effective_date");
      const r = recordDatedownReceived(ctx.events, c, { order_id: str(i, "order_id"), effective_date: dateIn(i, "effective_date"), consummation_on: optDate(i, "consummation_on") ?? ((order.closing_date as PlainDate | null) ?? null), received_at: at(i, ctx) });
      let row = persist(rt, ctx, "title_orders", str(i, "order_id"), { ...order, datedown_effective_date: str(i, "effective_date"), datedown_received_at: at(i, ctx), datedown_in_window: r.gate.open }).data;
      if (r.gate.open && row.status === "cleared") row = setStatus(rt, ctx, c, row, "dated_down");
      return { in_window: r.gate.open, reason: r.gate.reason, window_opens: r.gate.window_opens, order_status: row.status };
    }
    const gate = commitmentDatedownGate({ commitment_effective_date: (order.commitment_effective_date as PlainDate | null) ?? null, consummation_on: optDate(i, "consummation_on") ?? ((order.closing_date as PlainDate | null) ?? null) });
    const e = ctx.events.append({ type: "title.datedown.requested", applicationId: c.application_id, actor: ctx.actor, payload: { application_id: c.application_id, order_id: str(i, "order_id"), consummation_on: optDate(i, "consummation_on") ?? order.closing_date ?? null, window_opens: gate.window_opens, requested_at: at(i, ctx) } });
    return { requested: true, event: e.type, commitment_in_window: gate.open, window_opens: gate.window_opens };
  }) },
  // ---------------------------------------------------------------- agent vetting and wires (T8)
  { name: "vetSettlementAgent", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "party_id", "agent_type", "state", "property_state", "eo_policy_limit_cents", "eo_expires_on", "fidelity_limit_cents");
    const c = ectx(i, ctx); const r = vetSettlementAgent(EO_ETC({ ...i, at: at(i, ctx) }));
    const status = i.officer_exception_id ? "approved_with_conditions" : r.vetting_status;
    persist(rt, ctx, "settlement_agents", str(i, "party_id"), { party_id: str(i, "party_id"), agent_type: str(i, "agent_type"), state: str(i, "state"), license_number: optStr(i, "license_number"), license_verified_at: flag(i, "license_active") ? at(i, ctx) : null, alta_registry_id: optStr(i, "alta_registry_id"), underwriter_confirmed_by: optStr(i, "underwriter_confirmed_by"), eo_policy_limit_cents: cents(i.eo_policy_limit_cents), eo_expires_on: str(i, "eo_expires_on"), fidelity_limit_cents: cents(i.fidelity_limit_cents), best_practices_attestation_at: optStr(i, "best_practices_attestation_at"), wire_instructions_hash: optStr(i, "wire_instructions_hash"), vetting_status: status, vetting_expires_on: r.vetting_expires_on, officer_exception_id: optStr(i, "officer_exception_id"), reasons: r.reasons, conditions: r.conditions });
    recordAgentVetted(ctx.events, c, { party_id: str(i, "party_id"), ...r, vetting_status: status });
    if (status === "rejected") rt.escalations.open({ kind: "officer", loanId: ctx.loanId, payload: { application_id: c.application_id, settlement_agent_party_id: str(i, "party_id"), reasons: r.reasons, ask: "approve the agent outside policy, or offer the borrower alternatives" } }, ctx.actor);
    return { ...r, vetting_status: status };
  }), guardrails: [needsRole("AGENT_OUTSIDE_POLICY_OFFICER", "24.4 automation class: the partner officer approves an agent outside policy", (i) => i.officer_exception_id !== undefined && i.officer_exception_id !== null, ["officer"], "an agent that fails vetting is approved only by the partner officer's exception"), never("RESPA_8_NO_REFERRAL_CONSIDERATION", "§1024.14(b): no fee, kickback or thing of value for referrals", (i) => i.referral_consideration === true && i.acknowledge_respa_8 === true, "an agent that gives or receives referral consideration is rejected, never approved")] },
  { name: "lookupAltaRegistry", kind: "read", handler: compute(async (i, _ctx, rt) => {
    need(i, "party_id");
    const reg = optService<AltaRegistryPort>(rt, "altaRegistry"); if (!reg) return { party_id: str(i, "party_id"), alta_registry_id: null, underwriter_confirmed_by: null, phone: null, source: "portal lookup queued for the SM operator (no API — 00b-orig N7)" };
    return { party_id: str(i, "party_id"), ...(await reg.lookup(str(i, "party_id"))), source: "alta_registry", cache: "12 months" };
  }) },
  { name: "verifyWireInstructions", kind: "act", handler: compute(async (i, ctx, rt) => {
    need(i, "purpose", "beneficiary_party_id", "routing_number", "account_number", "instructions_channel");
    const app = appOf(i, ctx); const c = ectx(i, ctx);
    const prior = rt.store.list("wire_verifications", (d) => d.application_id === app && d.purpose === str(i, "purpose") && d.beneficiary_party_id === str(i, "beneficiary_party_id") && d.verified_at !== null).map((r) => r.data).at(-1) ?? null;
    const vendorSvc = optService<WireVerificationPort>(rt, "wireVerification");
    const vendorResult = typeof i.vendor_match === "string" ? { match: i.vendor_match as WireVerificationInput["vendor_match"], vendor_ref: optStr(i, "vendor_ref") } : vendorSvc ? await vendorSvc.verify({ application_id: app, purpose: str(i, "purpose"), beneficiary_party_id: str(i, "beneficiary_party_id"), routing_number: str(i, "routing_number"), account_number: str(i, "account_number") }) : { match: null, vendor_ref: null };
    const v: WireVerification = verifyWireInstructions({ application_id: app, purpose: str(i, "purpose") as WireVerificationInput["purpose"], beneficiary_party_id: str(i, "beneficiary_party_id"), routing_number: str(i, "routing_number"), account_number: str(i, "account_number"), instructions_channel: str(i, "instructions_channel") as WireVerificationInput["instructions_channel"], instructions_email_domain: optStr(i, "instructions_email_domain"), registered_email_domain: optStr(i, "registered_email_domain"),
      vendor: (optStr(i, "vendor") ?? (vendorSvc ? "fundingshield" : "manual_callback")) as WireVerificationInput["vendor"], vendor_match: vendorResult.match ?? null, prior_verified: prior ? { instructions_hash: String(prior.instructions_hash), verified_at: String(prior.verified_at) } : null, callback: (i.callback as WireVerificationInput["callback"] | undefined) ?? null, received_at: at(i, ctx), funding_at: optStr(i, "funding_at") });
    persist(rt, ctx, "wire_verifications", v.id, { ...v, vendor_ref: vendorResult.vendor_ref ?? null });
    const events = recordWireVerification(ctx.events, c, v);
    if (v.release_requires) rt.escalations.open({ kind: "funding_approver", loanId: ctx.loanId, payload: { application_id: app, wire_verification_id: v.id, reason: v.block_reason, hours_to_funding: v.hours_to_funding, requires: "second callback to an ALTA Registry / underwriter number, then funding_approver release (same day)" } }, ctx.actor);
    if (v.match_result === "changed" && str(i, "instructions_channel") === "email") ctx.events.append({ type: "fraud.case.candidate", applicationId: app, actor: ctx.actor, payload: { application_id: app, owner: "22.6", signal: "wire_instruction_change_by_email", wire_verification_id: v.id } });
    return { verification: v, prior_verified_at: prior?.verified_at ?? null, events: events.map((e) => e.type) };
  }), guardrails: [NO_WIRE_ALTERATION, NO_CALLBACK_SKIP, never("PAYOFF_WIRE_TO_SERVICER_OF_RECORD", "24.4 rule 13: all payoff wires go to the servicer's account of record, never to an individual", (i) => i.purpose === "payoff_existing_lien" && i.beneficiary_is_individual === true, "a payoff wire is verified against the servicer's published payoff instructions only")] },
  { name: "placeCallback", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "wire_verification_id", "number_source");
    const c = ectx(i, ctx); const rec = rt.store.get("wire_verifications", str(i, "wire_verification_id")); if (!rec) throw new RangeError(`no wire_verifications row ${str(i, "wire_verification_id")}`);
    const v = rec.data as unknown as WireVerification; const source = str(i, "number_source") as CallbackSource | "email";
    if (i.op === "release") {
      const released = releaseWireBlock(v, { actor_role: ctx.actor.role ?? "", second_callback_number_source: source, second_callback_completed: flag(i, "completed"), released_at: at(i, ctx) });
      persist(rt, ctx, "wire_verifications", released.id, { ...rec.data, ...released, released_by: `${ctx.actor.kind}:${ctx.actor.id}` });
      const events = recordWireVerification(ctx.events, c, { ...released, change_detected_at: null });
      return { verification: released, unblocked: !released.blocks_disbursement, events: events.map((e) => e.type) };
    }
    const e = ctx.events.append({ type: "wire.callback.placed", applicationId: c.application_id, actor: ctx.actor, payload: { application_id: c.application_id, wire_verification_id: v.id, number_source: source, completed: flag(i, "completed"), placed_at: at(i, ctx) } });
    return { placed: true, number_source: source, completed: flag(i, "completed"), event: e.type, note: v.release_requires ? "a blocked late change still needs the funding_approver's release (op=release)" : null };
  }), guardrails: [NO_CALLBACK_SKIP, needsRole("LATE_WIRE_CHANGE_FUNDING_APPROVER", "24.4 rule 13 / T8: a change within 48 hours of funding is released only by the funding_approver after a second callback", (i) => i.op === "release", ["funding_approver"], "only the funding_approver (26.3) releases a wire blocked by a late change"), never("CALLBACK_NUMBER_NEVER_FROM_EMAIL", "24.4 rule 13: the callback number comes from the ALTA Registry / underwriter / a prior verified record — never from the e-mail carrying the instructions", (i) => i.number_source === "email", "a callback to a number in the instruction e-mail proves nothing")] },
  // ---------------------------------------------------------------- payoffs (T5, T6)
  { name: "requestPayoff", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "liability_id", "existing_servicer_party_id", "requested_good_through", "state", "written_authorization_document_id");
    const app = appOf(i, ctx); const c = ectx(i, ctx); const requestedAt = at(i, ctx);
    const r = requestPayoff(ctx.events, c, { application_id: app, liability_id: str(i, "liability_id"), same_servicer: flag(i, "same_servicer"), servicing_loan_id: optStr(i, "servicing_loan_id"), existing_servicer_party_id: str(i, "existing_servicer_party_id"), requested_at: requestedAt, requested_on: optDate(i, "requested_on") ?? dateOf(requestedAt), request_channel: optStr(i, "request_channel") ?? "email", written_authorization_document_id: str(i, "written_authorization_document_id"), requested_good_through: dateIn(i, "requested_good_through"), state: str(i, "state"), refresh: flag(i, "refresh") });
    const prev = rt.store.get("payoff_demands", `${app}:${str(i, "liability_id")}`)?.data ?? {};
    const row = persist(rt, ctx, "payoff_demands", `${app}:${str(i, "liability_id")}`, { ...prev, application_id: app, liability_id: str(i, "liability_id"), existing_servicer_party_id: str(i, "existing_servicer_party_id"), same_servicer: flag(i, "same_servicer"), servicing_loan_id: optStr(i, "servicing_loan_id"), requested_at: requestedAt, request_channel: flag(i, "same_servicer") ? "servicing_16_1" : optStr(i, "request_channel") ?? "email", written_authorization_document_id: str(i, "written_authorization_document_id"), requested_good_through: str(i, "requested_good_through"), status: "requested", follow_up_due: r.follow_up_due, refresh_count: flag(i, "refresh") ? Number(prev.refresh_count ?? 0) + 1 : Number(prev.refresh_count ?? 0) }).data;
    return { status: row.status, follow_up_due: r.follow_up_due, same_servicer: flag(i, "same_servicer"), servicing_request: r.servicing_intake ? { request_id: r.servicing_intake.payload.request_id, federal_statement_due: r.servicing_intake.payload.federal_statement_due, governing_due: r.servicing_intake.payload.governing_due, timers: r.servicing_intake.payload.timers } : null, events: [r.demand_event.type, ...(r.servicing_event ? [r.servicing_event.type] : [])] };
  }) },
  { name: "parsePayoffStatement", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "liability_id", "statement_document_id", "statement_date", "principal_cents", "rate_pct", "interest_paid_through", "per_diem_cents", "good_through_date");
    const app = appOf(i, ctx); const c = ectx(i, ctx);
    const parsed = parsePayoffStatement({ principal_cents: cents(i.principal_cents), rate_pct: str(i, "rate_pct"), interest_paid_through: dateIn(i, "interest_paid_through"), per_diem_cents: cents(i.per_diem_cents), good_through_date: dateIn(i, "good_through_date"), fees_cents: optCents(i, "fees_cents") ?? 0n, recording_fee_cents: optCents(i, "recording_fee_cents") ?? 0n, escrow_shortage_cents: optCents(i, "escrow_shortage_cents") ?? 0n, credits_cents: optCents(i, "credits_cents") ?? 0n, statement_date: dateIn(i, "statement_date"), short_payoff: flag(i, "short_payoff"), stated_total_cents: optCents(i, "stated_total_cents") } as PayoffStatementInput);
    const prev = rt.store.get("payoff_demands", `${app}:${str(i, "liability_id")}`)?.data ?? {};
    const refresh = prev.status === "stale" || prev.status === "refreshed" || flag(i, "refresh");
    const e = recordPayoffStatement(ctx.events, c, { liability_id: str(i, "liability_id"), statement_document_id: str(i, "statement_document_id"), statement_date: dateIn(i, "statement_date"), good_through_date: dateIn(i, "good_through_date"), parsed, disbursement_date: optDate(i, "disbursement_date") ?? ((prev.disbursement_date as PlainDate | null) ?? null), refresh, received_at: at(i, ctx) });
    const status = String(e.payload.status);
    const row = persist(rt, ctx, "payoff_demands", `${app}:${str(i, "liability_id")}`, { ...prev, application_id: app, liability_id: str(i, "liability_id"), statement_received_at: at(i, ctx), statement_document_id: str(i, "statement_document_id"), statement_date: str(i, "statement_date"), good_through_date: str(i, "good_through_date"), principal_cents: cents(i.principal_cents), interest_cents: parsed.interest_cents, per_diem_cents: cents(i.per_diem_cents), fees_cents: parsed.fees_cents, escrow_shortage_cents: optCents(i, "escrow_shortage_cents") ?? 0n, credits_cents: optCents(i, "credits_cents") ?? 0n, total_cents: parsed.total_cents, short_payoff: parsed.short_payoff, status, disbursement_date: optDate(i, "disbursement_date") ?? prev.disbursement_date ?? null, wire_instructions_document_id: optStr(i, "wire_instructions_document_id") }).data;
    if (parsed.short_payoff) rt.escalations.open({ kind: "underwriting_reviewer", loanId: ctx.loanId, payload: { application_id: app, liability_id: str(i, "liability_id"), reason: "short payoff — not a lien paid in full; DU resubmission; unreleasable until a written release commitment" } }, ctx.actor);
    if (!parsed.per_diem_reconciles) rt.escalations.open({ kind: "settlement_agent", loanId: ctx.loanId, payload: { application_id: app, liability_id: str(i, "liability_id"), query: `per diem ${cents(i.per_diem_cents)} does not reconcile to the note rate (computed ${parsed.computed_per_diem_cents}); query the servicer — never correct its figure` } }, ctx.actor);
    return { ...parsed, status: row.status, covers_disbursement: e.payload.covers_disbursement };
  }), guardrails: [never("SERVICER_FIGURE_NEVER_CORRECTED", "24.4 edge cases: a per diem that does not reconcile is queried with the servicer; never 'correct' the servicer's figure", (i) => i.corrected_per_diem_cents !== undefined || i.corrected_total_cents !== undefined, "the statement's figures are stored as received; discrepancies go back to the servicer")] },
  { name: "computePayoffAtDate", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "on");
    const on = dateIn(i, "on"); const app = (i.application_id as string | undefined) ?? ctx.applicationId ?? "";
    const row = typeof i.liability_id === "string" && app ? rt.store.get("payoff_demands", `${app}:${str(i, "liability_id")}`)?.data ?? null : null;
    const figures = row ? { total_cents: cents(row.total_cents), per_diem_cents: cents(row.per_diem_cents), good_through_date: D(String(row.good_through_date)) } : (need(i, "total_cents", "per_diem_cents", "good_through_date"), { total_cents: cents(i.total_cents), per_diem_cents: cents(i.per_diem_cents), good_through_date: dateIn(i, "good_through_date") });
    const r = computePayoffAtDate(figures, on);
    const staleness = payoffStaleness({ status: (row ? String(row.status) : optStr(i, "status") ?? "received") as "received", good_through_date: figures.good_through_date, statement_date: row ? D(String(row.statement_date)) : optDate(i, "statement_date"), disbursement_date: flag(i, "planned_disbursement") ? on : optDate(i, "disbursement_date"), payment_posted_since: flag(i, "payment_posted_since"), as_of: optDate(i, "as_of") ?? dateOf(at(i, ctx)) });
    let refresh: string | null = null;
    if (row && flag(i, "planned_disbursement") && staleness.stale && ["received", "refreshed"].includes(String(row.status))) {
      const c = ectx(i, ctx);
      recordPayoffStale(ctx.events, c, { liability_id: str(i, "liability_id"), good_through_date: figures.good_through_date, disbursement_date: on, reasons: staleness.reasons, planning_total_cents: r.total_at_cents });
      persist(rt, ctx, "payoff_demands", `${app}:${str(i, "liability_id")}`, { ...row, status: "stale", disbursement_date: on, computed_total_at_disbursement_cents: r.total_at_cents });
      const rq = requestPayoff(ctx.events, c, { application_id: app, liability_id: str(i, "liability_id"), same_servicer: row.same_servicer === true, servicing_loan_id: (row.servicing_loan_id as string | null) ?? null, existing_servicer_party_id: String(row.existing_servicer_party_id), requested_at: at(i, ctx), requested_on: dateOf(at(i, ctx)), request_channel: String(row.request_channel ?? "email"), written_authorization_document_id: String(row.written_authorization_document_id), requested_good_through: on, state: optStr(i, "state") ?? "AZ", refresh: true });
      refresh = rq.demand_event.type;
    } else if (row && flag(i, "planned_disbursement")) persist(rt, ctx, "payoff_demands", `${app}:${str(i, "liability_id")}`, { ...row, disbursement_date: on, computed_total_at_disbursement_cents: r.total_at_cents });
    return { ...r, staleness, refresh_requested: refresh !== null, status: refresh ? "stale" : row?.status ?? null, funding_figure: r.stale ? null : figures.total_cents };
  }), guardrails: [never("FUNDING_PAYOFF_NEVER_FROM_STALE_STATEMENT", "24.4 guardrails: never compute a funding payoff from a stale statement (comment 36(c)(3)-3)", (i) => i.use_for_funding === true, "the planning figure is total + per diem × extra days; funding uses only a statement good through the disbursement date — refresh instead of 'adding a day'")] },
  { name: "decideEscrowTreatment", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "liability_id", "servicing_loan_id", "payoff_posted_on", "escrow_balance_cents", "settlement_date");
    const app = appOf(i, ctx); const c = ectx(i, ctx);
    const consent = i.consent && typeof i.consent === "object" ? (i.consent as { kind: string; captured_at: string }) : null;
    const r = decideEscrowTreatment({ same_servicer: i.same_servicer === undefined ? true : flag(i, "same_servicer"), payoff_posted_on: dateIn(i, "payoff_posted_on"), escrow_balance_cents: cents(i.escrow_balance_cents), consent: consent ? { kind: consent.kind, captured_at: D(consent.captured_at) } : null, settlement_date: dateIn(i, "settlement_date"), initial_escrow_deposit_cents: optCents(i, "initial_escrow_deposit_cents"), payoff_shortfall_cents: optCents(i, "payoff_shortfall_cents") ?? 0n, net_against_shortfall_flag: flag(i, "net_against_shortfall_flag") });
    recordEscrowTreatment(ctx.events, c, { liability_id: str(i, "liability_id"), servicing_loan_id: str(i, "servicing_loan_id"), ...r });
    const prev = rt.store.get("payoff_demands", `${app}:${str(i, "liability_id")}`)?.data ?? {};
    persist(rt, ctx, "payoff_demands", `${app}:${str(i, "liability_id")}`, { ...prev, application_id: app, liability_id: str(i, "liability_id"), same_servicer: true, servicing_loan_id: str(i, "servicing_loan_id"), escrow_treatment: r.escrow_treatment, consent_id: optStr(i, "consent_id"), refund_due_on: r.refund_due_on });
    return r;
  }), guardrails: [never("ESCROW_CREDIT_NEEDS_CONSENT", "§1024.34(b)(2): the credit to the new loan needs the borrower's consent and the same lender/owner/servicer", (i) => i.force_credit_without_consent === true, "without the escrow_credit_to_new_loan consent the balance is refunded under (b)(1) by 3.5"), never("NETTING_ONLY_UNDER_FLAG", "24.4 rule 7(c): netting against a payoff shortfall only under feature flag escrow.payoff.net_against_shortfall with disclosure", (i) => i.net_against_shortfall === true && i.net_against_shortfall_flag !== true, "the 3.5 feature flag is off — no netting")] },
  // ---------------------------------------------------------------- subordinations (T7)
  { name: "requestSubordination", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "liability_id", "lienholder_party_id", "lien_kind", "first_cents", "value_cents");
    const app = appOf(i, ctx); const c = ectx(i, ctx);
    const line = optCents(i, "heloc_line_cents"), drawn = optCents(i, "heloc_drawn_cents"); const balance = optCents(i, "balance_cents") ?? drawn ?? 0n;
    const ratios = helocRatios({ first_cents: cents(i.first_cents), drawn_cents: drawn ?? balance, line_cents: line ?? balance, value_cents: cents(i.value_cents) });
    const statutory = flag(i, "statutory_position_preserved");
    const requestedOn = optDate(i, "requested_on") ?? dateOf(at(i, ctx));
    if (!statutory) recordSubordinationRequested(ctx.events, c, { liability_id: str(i, "liability_id"), lienholder_party_id: str(i, "lienholder_party_id"), lien_kind: str(i, "lien_kind"), requested_on: requestedOn, ...ratios, heloc_line_cents: line, heloc_drawn_cents: drawn });
    const row = persist(rt, ctx, "subordinations", `${app}:${str(i, "liability_id")}`, { application_id: app, liability_id: str(i, "liability_id"), lienholder_party_id: str(i, "lienholder_party_id"), lien_kind: str(i, "lien_kind"), statutory_position_preserved: statutory, requested_at: statutory ? null : requestedOn, heloc_line_cents: line, heloc_drawn_cents: drawn, ...ratios, terms_ok: null, recordable: null, status: statutory ? "waived_statutory" : "requested", package: ["new loan terms", "appraisal value", "CD draft"] }).data;
    return { ...ratios, status: row.status, requested_on: statutory ? null : requestedOn, du_inputs: { cltv_bps: ratios.cltv_bps, hcltv_bps: ratios.hcltv_bps } };
  }) },
  { name: "checkSubordinateTerms", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "liability_id", "terms");
    const app = appOf(i, ctx); const c = ectx(i, ctx); const t = obj<SubordinateTerms & { note_date: string; maturity_or_balloon_on?: string | null }>(i, "terms");
    const terms = checkSubordinateTerms({ ...t, note_date: D(t.note_date), maturity_or_balloon_on: t.maturity_or_balloon_on ? D(t.maturity_or_balloon_on) : null, ...((t.lien_kind ?? optStr(i, "lien_kind")) ? { lien_kind: (t.lien_kind ?? optStr(i, "lien_kind"))! } : {}) });
    const prev = rt.store.get("subordinations", `${app}:${str(i, "liability_id")}`)?.data ?? { application_id: app, liability_id: str(i, "liability_id"), status: "requested" };
    const r = recordSubordinationAgreement(ctx.events, c, { liability_id: str(i, "liability_id"), agreement_document_id: optStr(i, "agreement_document_id") ?? "pending", executed_at: optDate(i, "executed_at"), recordable: i.recordable === undefined ? true : flag(i, "recordable"), terms });
    const row = persist(rt, ctx, "subordinations", `${app}:${str(i, "liability_id")}`, { ...prev, agreement_received_at: at(i, ctx), agreement_document_id: optStr(i, "agreement_document_id"), executed_at: optStr(i, "executed_at"), recordable: i.recordable === undefined ? true : flag(i, "recordable"), terms_ok: terms.terms_ok, terms_reasons: terms.reasons, status: r.status }).data;
    if (!terms.terms_ok) rt.escalations.open({ kind: "underwriting_reviewer", loanId: ctx.loanId, payload: { application_id: app, liability_id: str(i, "liability_id"), reasons: terms.reasons, options: ["pay off the lien (DU resubmission; cash-out classification check 23.1/B2-1.3)", "restructure", "borrower withdraws"] } }, ctx.actor);
    return { ...terms, status: row.status, event: r.event.type, lien_must_be_paid_off: !terms.terms_ok };
  }) },
  // ---------------------------------------------------------------- vesting (T9, T10)
  { name: "reviewTrust", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "borrower_id", "trust");
    const app = appOf(i, ctx); const c = ectx(i, ctx); const t = obj<TrustReviewInput>(i, "trust"); const r = reviewTrust(t);
    persist(rt, ctx, "trust_reviews", `${app}:${str(i, "borrower_id")}`, { application_id: app, borrower_id: str(i, "borrower_id"), trust_name: t.trust_name, certification_document_id: t.certification_document_id ?? null, trust_agreement_document_id: t.trust_agreement_document_id ?? null, attorney_opinion_document_id: t.attorney_opinion_document_id ?? null, settlor_is_trustee: t.settlor_is_trustee, institutional_trustee: t.institutional_trustee, primary_beneficiary_is_settlor: t.primary_beneficiary_is_settlor, power_to_mortgage: t.power_to_mortgage, revocable: t.revocable, occupancy_ok: t.occupancy_ok, qualifying_party_ok: t.qualifying_party_ok, rider_required: r.rider_required, result: r.result, sfc_168: r.sfc_168, reasons: r.reasons, signature_plan: r.signature_plan, reviewed_at: at(i, ctx) });
    recordTrustReviewed(ctx.events, c, { borrower_id: str(i, "borrower_id"), trust_name: t.trust_name, ...r });
    if (r.sfc_168) ctx.events.append({ type: "delivery.sfc.queued", applicationId: app, actor: ctx.actor, payload: { application_id: app, code: "168", reason: "inter vivos revocable trust (B2-2-05)", borrower_id: str(i, "borrower_id") } });
    const verdict = vestingVerdict(rt, ctx, c, app);
    return { ...r, all_vesting_reviews_eligible: verdict.payload.all_eligible };
  }) },
  { name: "reviewPOA", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "borrower_id", "poa");
    const app = appOf(i, ctx); const c = ectx(i, ctx); const p = obj<PoaReviewInput>(i, "poa"); const r = reviewPOA(p);
    persist(rt, ctx, "poa_reviews", `${app}:${str(i, "borrower_id")}`, { application_id: app, borrower_id: str(i, "borrower_id"), poa_document_id: optStr(i, "poa_document_id"), agent_party_id: optStr(i, "agent_party_id"), agent_relationship: p.agent_relationship, agent_ineligible_class: p.agent_ineligible_class, interactive_session_recording_id: p.interactive_session_recording_id, cpl_required: r.cpl_required, notarized: p.notarized, dated_valid: p.dated_valid, references_property: p.references_property, names_match: p.names_match, recording_required: p.recording_required ?? false, original_to_custodian: p.original_to_custodian ?? false, applicable_law_override: p.applicable_law_override, override_statement_document_id: p.override_statement_document_id, result: r.result, reasons: r.reasons, transaction_type: p.transaction_type, reviewed_at: at(i, ctx) });
    recordPoaReviewed(ctx.events, c, { borrower_id: str(i, "borrower_id"), ...r });
    const verdict = vestingVerdict(rt, ctx, c, app);
    return { ...r, all_vesting_reviews_eligible: verdict.payload.all_eligible };
  }), guardrails: [never("POA_CASH_OUT_NEVER", "24.4 guardrails / B8-5-05: never proceed with a POA cash-out", (i) => { const p = i.poa as PoaReviewInput | undefined; return !!p && p.transaction_type === "cash_out" && i.force_eligible === true; }, "cash-out refinances are ineligible for POA execution absent the applicable-law override with the written file statement"), never("AOL_BARRED_ON_POA", "B7-2-06: loans using power of attorney are ineligible for the attorney opinion letter", (i) => i.use_aol === true, "an AOL cannot be used on a POA loan (rule 12)")] },
  // ---------------------------------------------------------------- CPL (T14) and gates
  { name: "requestCPL", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "order_id");
    const c = ectx(i, ctx); const order = orderRow(rt, str(i, "order_id"));
    if (i.op === "receive") {
      need(i, "cpl_document_id", "cpl_date", "cpl_underwriter_party_id", "cpl_agent_party_id", "addressees", "partner_name");
      const g = cplBeforeFundingGate({ cpl_underwriter_party_id: str(i, "cpl_underwriter_party_id"), underwriter_party_id: (order.underwriter_party_id as string | null) ?? null, cpl_agent_party_id: str(i, "cpl_agent_party_id"), settlement_agent_party_id: String(order.settlement_agent_party_id), addressees: optList<string>(i, "addressees"), partner_name: str(i, "partner_name"), sm_addressee_required: flag(i, "sm_addressee_required"), transaction_ref: optStr(i, "transaction_ref") ?? c.application_id, application_ref: c.application_id, cpl_date: dateIn(i, "cpl_date"), funding_date: optDate(i, "funding_date") ?? ((order.closing_date as PlainDate | null) ?? null), validity_days: typeof i.validity_days === "number" ? i.validity_days : null });
      recordCplReceived(ctx.events, c, { order_id: str(i, "order_id"), cpl_document_id: str(i, "cpl_document_id"), cpl_date: dateIn(i, "cpl_date"), ...g });
      persist(rt, ctx, "title_orders", str(i, "order_id"), { ...order, cpl: { document_id: str(i, "cpl_document_id"), cpl_date: str(i, "cpl_date"), underwriter_party_id: str(i, "cpl_underwriter_party_id"), agent_party_id: str(i, "cpl_agent_party_id"), addressees: optList<string>(i, "addressees"), transaction_ref: optStr(i, "transaction_ref") ?? c.application_id, validity_days: typeof i.validity_days === "number" ? i.validity_days : null }, cpl_addressee_ok: g.cpl_addressee_ok && g.open, cpl_issued_at: g.open ? at(i, ctx) : null });
      return { ...g };
    }
    const e = ctx.events.append({ type: "cpl.requested", applicationId: c.application_id, actor: ctx.actor, payload: { application_id: c.application_id, order_id: str(i, "order_id"), underwriter_party_id: order.underwriter_party_id ?? null, settlement_agent_party_id: order.settlement_agent_party_id, addressee: `${optStr(i, "partner_name") ?? "Partner"}, its successors and/or assigns` + (flag(i, "sm_addressee_required") ? "; Supermortgage as bailee/secured party" : ""), requested_at: at(i, ctx) } });
    return { requested: true, event: e.type, addressee: e.payload.addressee };
  }) },
  { name: "evaluateGates", kind: "act", handler: compute((i, ctx, rt) => {
    need(i, "command");
    const command = str(i, "command") as keyof typeof GATES_24_4; if (!(command in GATES_24_4)) throw new RangeError(`command ${command} is not one of ${Object.keys(GATES_24_4).join(", ")}`);
    const app = appOf(i, ctx); const facts = assembleFacts(rt, app, i, ctx);
    const results: Record<string, GateOutcome> = {}; for (const code of GATES_24_4[command]) results[code] = outcome(code, facts);
    const ev = evalGates(command, results);
    const aol = i.aol && typeof i.aol === "object" ? evaluateAolPath(obj<AolInput>(i, "aol")) : null;
    if (aol && typeof i.order_id === "string") recordAolDecision(ctx.events, ectx(i, ctx), aol, { order_id: str(i, "order_id"), approved_by: optStr(i, "approved_by") });
    const cema = i.cema && typeof i.cema === "object" ? (() => { const x = i.cema as { new_note_cents: unknown; consolidated_upb_cents: unknown; existing_lender_will_assign?: boolean; mortgage_tax_rate_bps?: number }; return cemaNewMoney({ new_note_cents: cents(x.new_note_cents), consolidated_upb_cents: cents(x.consolidated_upb_cents), existing_lender_will_assign: x.existing_lender_will_assign !== false, ...(typeof x.mortgage_tax_rate_bps === "number" ? { mortgage_tax_rate_bps: x.mortgage_tax_rate_bps } : {}) }); })() : null;
    const order = latestOrder(rt, app);
    const clearance = order ? clearanceCheck({ open_blocking_items: openBlocking(rt, String(order.id)).length, cpl_received: order.cpl_addressee_ok === true, agent_vetted: results.SM_SETTLEMENT_AGENT_VETTING_GATE?.open ?? outcome("SM_SETTLEMENT_AGENT_VETTING_GATE", facts).open, wire_verified: results.SM_WIRE_VERIFICATION_GATE?.open ?? outcome("SM_WIRE_VERIFICATION_GATE", facts).open, payoffs_current: results.SM_PAYOFF_GOOD_THROUGH_GATE?.open ?? outcome("SM_PAYOFF_GOOD_THROUGH_GATE", facts).open, subordinations_executed: results.FNMA_B2_1_2_04_RESUBORDINATION_GATE?.open ?? outcome("FNMA_B2_1_2_04_RESUBORDINATION_GATE", facts).open }) : null;
    if (order && clearance?.can_clear && (order.status === "reviewed" || order.status === "curative_open") && flag(i, "clear_when_ready")) setStatus(rt, ctx, ectx(i, ctx), order, "cleared");
    ctx.events.append({ type: "title.gates.evaluated", applicationId: app, actor: ctx.actor, payload: { application_id: app, command, open: ev.open, refused_by: ev.refused_by, gates: ev.gates, evaluated_at: at(i, ctx) } });
    return { ...ev, refusal: ev.open ? null : `${command} refused by ${ev.refused_by}: ${ev.gates.find((g) => g.code === ev.refused_by)?.reason}`, clearance, aol, cema, facts_used: Object.keys(facts) };
  }), guardrails: [never("GATES_NEVER_DISABLED", "24.4 guardrails: never disable a gate", (i) => i.disable_gate !== undefined || i.skip_gates === true || i.force_open === true, "gates are evaluated on the facts; a closed gate is cleared by curing the fact, never by switching it off"), never("ALTA_2021_FORM_REQUIRED", "24.4 guardrails: never treat a non-ALTA-2021 policy as acceptable", (i) => i.accept_non_2021_form === true, "B7-2-03: the 2021 ALTA Loan Policy is mandatory for every loan in scope"), never("AOL_WHERE_BARRED", "24.4 guardrails / B7-2-06: never use an AOL where barred (co-op, leasehold/CLT, MH, HomeStyle, TX 50(a)(6), POA)", (i) => { const a = i.aol as AolInput | undefined; return !!a && i.force_aol === true && !!(a.co_op || a.leasehold_or_clt || a.manufactured_home || a.homestyle || a.tx_50a6 || a.poa); }, "the AOL alternative is refused for an ineligible transaction; title insurance (TX: T-2 + T-42 + T-42.1) is required"), needsRole("AOL_PROGRAM_OFFICER", "24.4 automation class: the partner officer approves the attorney-opinion-letter program (24.4-Q1)", (i) => i.approve_aol_program === true, ["officer"], "enabling the AOL path is the partner officer's decision")] },
  { name: "writeDecision", kind: "write", handler: compute((i, ctx) => { need(i, "action", "rationale"); return decision()({ ...i, rule_set_version: str(i, "rule_set_version") || RULE_SET_VERSION_24_4, agent: str(i, "agent") || AGENT_24_4.id }, ctx); }) },
]);
