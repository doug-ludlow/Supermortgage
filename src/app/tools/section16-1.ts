/**
 * §16.1 tools — the spec's tool strings for process 16.1, verbatim, via
 * `defineTools("16.1", "payoff-release", defs)` from ../tools.ts (see section13.ts). Spread by ./section16.ts.
 * Guardrails encode the spec's sentences: figures only from `payoff_quotes` (the rendered statement is built from the
 * `payoff_quotes` / `payoff_statements` rows — the agent supplies display fields, never a figure; a recompute runs the
 * calculator on the post-event ledger facts and never takes a total); wire instructions only from the vault's active
 * version (anything else is a fraud signal to `security-records`, never approved); no statement to an unverified third
 * party (any requester other than the borrower or a confirmed successor) without a borrower-of-record copy; no oral
 * figure before identity verification; the agent cannot waive fees > $100 without `officer` approval (the waiver is
 * applied by `computePayoffQuote`); every recompute Δ is explained; the prepayment premium is asserted 0; the accuracy
 * gate is forced only with a reason at deadline − 1 BD; `human_agent` may annotate but never alter figures; in FL/TX/CA a
 * low figure is absorbed, never demanded from a party that relied on it (the demand is refused by the engine).
 *
 * Events the timers listen for (all appended here, to the event store, by these handlers):
 *   `payoff.request.received{channel, written, requester, received_on, good_through, statutory_statement_due}` — the written
 *     request, recorded by `computePayoffQuote` through `payoffRequestIntake` once per request id before the engine's first
 *     run (arms REGZ_1026_36C3_PAYOFF_STMT_7BD, STATE_PAYOFF_STMT_DEADLINE, SM_PAYOFF_GOOD_THROUGH_MAX_30, SM_PAYOFF_THIRD_PARTY_AUTH_1BD);
 *   `payoff.quote.requested{mode}` — an oral/portal/API/internal quote request (arms SM_PAYOFF_ORAL_QUOTE_SAME_SESSION /
 *     SM_PAYOFF_PORTAL_QUOTE_60S); `payoff.quote.computed{quote_type, oral}` — every computed figure (satisfies them);
 *   `notice.render_requested{template, …gate facts}` (arms the accuracy and wire gates), `payoff.quote.recompute{delta}`,
 *   `payoff.statement.updated{state, payment_date}` (FL cutoff), `payoff.statement.sent{updated, all_prior_recipients}`,
 *   `payoff.statement.delivered{updated, state}`, `notice.sent{template, sequence}`, `payoff.nib_maturity.resolved{outcome}`,
 *   `payoff.request.third_party.resolved{outcome}`, `payoff.funds.over{overage_cents}` / `payoff.funds.short{shortage_cents}`,
 *   `case.opened{kind=qc_finding}` (CT interest forfeiture on a breached statement deadline).
 */
import { defineTools, compute, escalate, never, needsRole, decision, cents, str, flag, type ToolDef, type ToolInput } from "../tools.ts";
import type { EscalationKind } from "../escalations.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Recipient } from "../../notices/channel.ts";
import { RELIANCE_STATES, type Components, type Accrual } from "../../domain/payoff/quote.ts";
import { accuracyGate, goodThroughPolicy, statutoryStatementDue, wireVerifyGate, mintVerificationToken, payoffQuoteRow, stateVariant, escrowParagraph, fundsReceived, recomputeOnEvent, updatedStatementRecipients, payoffRequestIntake, quoteRequestIntake, thirdPartyStatementGuard, statementPayload, updatedStatementPayload, recomputedComponents, alternativeFigures16, oralQuote, statementDeadlineBreach, FIGURE_KEYS, CALC_VERSION, type RateInForce, type ScheduledDisbursement, type ActiveStatement, type MintedToken, type QuoteRowFigures } from "../../domain/payoff/ops-16-1.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const date = (i: ToolInput, k: string): PlainDate => { need(i, k); return D(str(i, k)); };
const optDate = (i: ToolInput, k: string): PlainDate | null => (i[k] === undefined || i[k] === null || i[k] === "" ? null : D(str(i, k)));
const optCents = (i: ToolInput, k: string): Cents | undefined => (i[k] === undefined || i[k] === null || i[k] === "" ? undefined : cents(i[k]));
const dateOf = (v: unknown): PlainDate | null => (typeof v === "string" && v ? D(v) : null);
type Cents = bigint;
type QuoteType = "statement" | "oral" | "portal" | "internal" | "updated";
type RecipientIn = { party_id: string; channel: string; name?: string; address?: string; email?: string };
const AGENT = "payoff-release";
const STATEMENT_TEMPLATE = "NTC_REGZ_36C3_PAYOFF_STMT";
const STATEMENT_TEMPLATES = /^NTC_(REGZ_36C3_PAYOFF_STMT|PAYOFF_UPDATED_STMT)/;
const bigs = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
const today = (now: string): PlainDate => D(now.slice(0, 10));
/** A third party is any requester other than the borrower or a confirmed successor (7.6 `requesterAuthorization`). */
const isThirdParty = (t: string): boolean => t !== "" && t !== "borrower" && t !== "confirmed_successor";
const borrowerIds = (i: ToolInput): readonly string[] => (Array.isArray(i.borrower_party_ids) ? (i.borrower_party_ids as string[]) : ["borrower"]);
const recipientsOf = (i: ToolInput): readonly RecipientIn[] => (Array.isArray(i.recipients) ? (i.recipients as RecipientIn[]) : []);
const inlineFigures = (i: ToolInput): string[] => { const p = (i.payload as Record<string, unknown> | undefined) ?? {}; return FIGURE_KEYS.filter((k) => p[k] !== undefined); };
/** The Notice Registry recipient from the tool's `{party_id, channel, name?, address?, email?}` row: the channel names where the address goes. */
const toRecipient = (r: RecipientIn): Recipient => ({ partyId: r.party_id, name: r.name ?? r.party_id, mailingAddress: r.channel === "mail" ? (r.address ?? null) : (r.address && !r.address.includes("@") ? r.address : null),
  ...(r.email ? { email: r.email } : r.channel === "email" && r.address ? { email: r.address } : {}), ...(r.channel === "portal" ? { portalUser: true } : {}) });

const COMPONENT_KEYS = ["nib_deferred_cents", "nib_forborne_cents", "late_charges_cents", "fees_cents", "corporate_advances_cents", "escrow_advance_cents", "recording_fee_cents", "mi_premium_cents", "buydown_credit_cents", "suspense_credit_cents"] as const;
/** `payoff_quotes` components from the tool input (bigint cents; optional lines omitted when absent — exactOptionalPropertyTypes). */
function componentsOf(i: ToolInput, goodThrough: PlainDate): Components {
  const opt = (k: keyof Components & string): Partial<Components> => { const v = optCents(i, k); return v === undefined ? {} : ({ [k]: v } as Partial<Components>); };
  return { upb_cents: cents(i.upb_cents), rate_pct: str(i, "rate_pct"), lpi_due: date(i, "lpi_due"), good_through: goodThrough, ...(str(i, "accrual_method") ? { method: str(i, "accrual_method") as Accrual } : {}),
    ...COMPONENT_KEYS.reduce((acc, k) => ({ ...acc, ...opt(k) }), {} as Partial<Components>) };
}
/** The post-event ledger facts a recompute applies to the original quote's components (only the keys the caller states). */
function componentChanges(i: ToolInput): Partial<Components> {
  const out: Record<string, unknown> = {};
  if (i.upb_cents !== undefined) out.upb_cents = cents(i.upb_cents); if (str(i, "rate_pct")) out.rate_pct = str(i, "rate_pct"); if (str(i, "lpi_due")) out.lpi_due = D(str(i, "lpi_due")); if (str(i, "accrual_method")) out.method = str(i, "accrual_method");
  for (const k of COMPONENT_KEYS) { const v = optCents(i, k); if (v !== undefined) out[k] = v; }
  return out as Partial<Components>;
}

export const TOOLS_16_1: readonly ToolDef[] = defineTools("16.1", AGENT, [
  // ---- the deterministic PayoffCalculator: the request intake (7.6) once per request id, then one immutable payoff_quotes row per figure
  { name: "computePayoffQuote", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "loan_id", "upb_cents", "rate_pct", "lpi_due", "good_through");
      const loanId = str(i, "loan_id"); const state = str(i, "state") || "OH"; const quoteType = (str(i, "quote_type") || "statement") as QuoteType; const now = today(ctx.now);
      // ---- inputs and triggers: a written request is recorded once (`payoff.request.received{written}` starts the federal/state clocks); an oral/portal/API/internal quote is a `payoff.quote.requested{mode}` (no §1026.36(c)(3) clock)
      const requestId = str(i, "request_id") || (quoteType === "statement" ? `pr-${loanId}-${str(i, "received_on") || str(i, "received_at") || ctx.now}` : `qr-${loanId}-${quoteType}-${ctx.now}`);
      let request = rt.store.get("payoff_requests", requestId)?.data ?? null; let thirdParty: ReturnType<typeof payoffRequestIntake>["third_party"] | null = null;
      if (quoteType === "statement" && !request) {
        need(i, "channel", "requester_type");
        const intake = payoffRequestIntake({ request_id: requestId, loan_id: loanId, channel: str(i, "channel"), written: i.written === undefined ? true : flag(i, "written"), received_at: str(i, "received_at") || null, received_on: optDate(i, "received_on"), postmark_on: optDate(i, "postmark_on"), vendor_receipt_on: optDate(i, "vendor_receipt_on"),
          state, requester_type: str(i, "requester_type"), authorization_evidence: flag(i, "authorization_evidence"), requested_good_through: date(i, "good_through"), requested_payoff_on: optDate(i, "requested_payoff_on"), borrower_party_ids: borrowerIds(i), delivery_channel_requested: str(i, "delivery_channel_requested") || null });
        request = rt.store.put("payoff_requests", requestId, intake.row, ctx.actor, ctx.now).data; thirdParty = intake.third_party;
        ctx.events.append({ type: intake.event.type, loanId, aggregate: { kind: "payoff_request", id: requestId }, actor: ctx.actor, payload: { ...intake.event.payload } });
        if (thirdParty.third_party && thirdParty.action === "verified") ctx.events.append({ type: "payoff.request.third_party.resolved", loanId, actor: ctx.actor, payload: { outcome: "verified", request_id: requestId, classification: thirdParty.classification, due_on: thirdParty.due_on } });
        // 7.6 state machine: a consumer request, or an agent with authorization evidence, is `requester_verified` on intake (SM_PAYOFF_REQUESTER_VERIFY_1BD)
        if (intake.row.requester_verified === true) ctx.events.append({ type: "payoff.request.requester_verified", loanId, actor: ctx.actor, payload: { request_id: requestId, requester_type: str(i, "requester_type"), classification: thirdParty.classification } });
      } else if (quoteType !== "statement" && quoteType !== "updated") {
        const qr = quoteRequestIntake({ request_id: requestId, mode: str(i, "mode") || quoteType, channel: str(i, "channel") || null, requested_at: str(i, "requested_at") || ctx.now, identity_verified: flag(i, "identity_verified") });
        ctx.events.append({ type: qr.type, loanId, actor: ctx.actor, payload: { ...qr.payload } });
      }
      const received = request ? D(String(request.received_on)) : (optDate(i, "received_on") ?? now);
      const policy = goodThroughPolicy({ state, received_on: received, issued_on: now, requested_good_through: date(i, "good_through") });
      const requested = componentsOf(i, policy.good_through); const rates = (i.rate_segments as RateInForce[] | undefined) ?? null;
      const waiver = cents(i.fee_waiver_cents);
      const row = payoffQuoteRow({ components: requested, rates, ledger_snapshot_id: str(i, "ledger_snapshot_id") || null, fee_waiver_cents: waiver });
      const c = row.components;
      const alt = i.installment_due ? alternativeFigures16(c, { calc_at: now, installment_due: date(i, "installment_due"), installment_principal_cents: cents(i.installment_principal_cents), ...(flag(i, "autodraft") ? { autodraft: true } : {}) }) : null;
      const due = statutoryStatementDue(state, received, optDate(i, "requested_payoff_on") ?? (request ? dateOf(request.requested_payoff_on) : null));
      const id = str(i, "quote_id") || `pq-${loanId}-${quoteType}-${ctx.now}`;
      const rec = rt.store.put("payoff_quotes", id, { loan_id: loanId, request_id: request ? String(request.id) : (quoteType === "statement" || quoteType === "updated" ? null : requestId), quote_type: quoteType, calc_at: ctx.now, state, ...row.figures, components: c, rate_segments_in_force: rates, fees_waived_reason: waiver > 0n ? str(i, "fee_waiver_reason") || null : null, escrow_treatment: "refund_separately", valid_until: policy.valid_until, good_through_capped: policy.capped, alt_figures: alt,
        deadlines: { federal: due.federal_statement_due, state: due.statutory_statement_due, governing: due.governing, governing_due: due.governing_due, warning_on: due.warning_on, timers: due.timers }, hash: row.hash, rule_set: "16.1@rules.v1", supersedes_quote_id: null, reason: null, superseded_by_id: null }, ctx.actor, ctx.now);
      if (request && quoteType === "statement") rt.store.put("payoff_requests", requestId, { ...request, quote_id: id, status: "calculating" }, ctx.actor, ctx.now);
      ctx.events.append({ type: "payoff.quote.computed", loanId, aggregate: { kind: "payoff_quote", id }, actor: ctx.actor, payload: { quote_id: id, request_id: rec.data.request_id, quote_type: quoteType, mode: quoteType === "statement" ? "written" : quoteType, oral: quoteType === "oral", total_cents: row.total_cents.toString(), per_diem_cents: row.per_diem_cents.toString(), good_through: c.good_through, hash: row.hash, ledger_snapshot_id: row.figures.ledger_snapshot_id, fees_waived_cents: row.waived_cents.toString() } });
      // rule 11: the voice/chat agent speaks the row's figure — the transcript with its disclosures comes from the engine, never from the model
      const oral = quoteType === "oral" ? oralQuote({ channel: (["ai_voice", "chat", "phone"].includes(str(i, "channel")) ? str(i, "channel") : "ai_voice") as "ai_voice", identity_verified: true, state, quote: { total_cents: row.total_cents, per_diem_cents: row.per_diem_cents, good_through: c.good_through }, clicked_written_at: str(i, "clicked_written_at") || null }) : null;
      return { ...rec.data, third_party: thirdParty, oral };
    }),
    guardrails: [
      never("NO_ORAL_BEFORE_IDV", "16.1 guardrail: no oral figure before identity verification (rule 11; 4.x standards)", (i) => (str(i, "quote_type") === "oral" || str(i, "mode") === "oral") && !flag(i, "identity_verified"), "verify identity first; the automation disclosure and verification precede any figure"),
      never("NO_PREPAYMENT_PREMIUM", "16.1 rule 6 / C-1.2-03: the servicer cannot impose or collect a prepayment premium on the conforming book", (i) => cents(i.prepayment_premium_cents) > 0n, "prepayment premium is asserted 0"),
      never("FEE_WAIVER_NEEDS_REASON", "2.7 waiver policy: a fee waiver on the payoff figure carries its reason", (i) => cents(i.fee_waiver_cents) > 0n && !str(i, "fee_waiver_reason"), "state the 2.7 waiver basis"),
      needsRole("FEE_WAIVER_OVER_100_OFFICER", "16.1 guardrail: the agent cannot waive fees > $100 without officer approval (2.7 waiver policy)", (i) => cents(i.fee_waiver_cents) > 10_000n, ["officer"], "route the waiver to the officer"),
    ] },
  // ---- SM_PAYOFF_STMT_ACCURACY_GATE ------------------------------------------------------------------------------------
  { name: "assertAccuracyGate", kind: "act", handler: compute((i, ctx, rt) => {
      const force = flag(i, "force") ? { reason: str(i, "force_reason"), today: optDate(i, "today") ?? today(ctx.now), deadline_on: date(i, "deadline_on") } : null;
      const g = accuracyGate({ ledger_clean: flag(i, "ledger_clean"), pending_reversal: flag(i, "pending_reversal"), rate_segments_final: flag(i, "rate_segments_final"), in_foreclosure: flag(i, "in_foreclosure"), firm_figures_present: flag(i, "firm_figures_present"), in_bankruptcy: flag(i, "in_bankruptcy"), bk_figures_present: flag(i, "bk_figures_present"), force });
      if (str(i, "quote_id")) rt.store.put("payoff_quote_gates", str(i, "quote_id"), { quote_id: str(i, "quote_id"), loan_id: str(i, "loan_id") || null, ...g, asserted_at: ctx.now }, ctx.actor, ctx.now);
      ctx.events.append({ type: g.open ? "payoff.quote.gate_passed" : "payoff.quote.gated", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, actor: ctx.actor, payload: { gate: g.gate, quote_id: str(i, "quote_id") || null, state: g.state, reasons: g.reasons, forced: g.forced } });
      return g;
    }),
    guardrails: [never("FORCE_NEEDS_REASON", "16.1 state machine: gated → computed may be forced only with a best-evidence figure and a reason when the deadline would otherwise breach (7.6 rule)", (i) => flag(i, "force") && !str(i, "force_reason"), "state the best-evidence basis for forcing the gate")] },
  // ---- SM_PAYOFF_WIRE_VERIFY_GATE + SM_PAYOFF_STMT_ACCURACY_GATE + render -----------------------------------------------
  { name: "renderStatement", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "loan_id", "quote_id", "active_wire_instruction_version_id");
      const loanId = str(i, "loan_id"); const quoteId = str(i, "quote_id"); const now = today(ctx.now);
      const q = rt.store.get("payoff_quotes", quoteId)?.data ?? null; if (!q) throw new RangeError(`no payoff_quotes row ${quoteId} — figures come only from payoff_quotes`);
      const token = str(i, "verification_token") || null; const minted = token ? ((rt.store.get("payoff_verification_tokens", token)?.data as MintedToken | undefined) ?? null) : null;
      const activeVersion = str(i, "active_wire_instruction_version_id"); const source = (str(i, "wire_instruction_source") || "vault") as "vault";
      const g = wireVerifyGate({ wire_instruction_version_id: str(i, "wire_instruction_version_id") || null, active_vault_version_id: activeVersion, verification_token: token, source, statement_hash: String(q.hash ?? ""), minted });
      // the accuracy gate result: asserted inline (facts on the input) or the stored assertAccuracyGate result for this quote
      const acc = i.ledger_clean !== undefined ? accuracyGate({ ledger_clean: flag(i, "ledger_clean"), pending_reversal: flag(i, "pending_reversal"), rate_segments_final: flag(i, "rate_segments_final"), in_foreclosure: flag(i, "in_foreclosure"), firm_figures_present: flag(i, "firm_figures_present"), in_bankruptcy: flag(i, "in_bankruptcy"), bk_figures_present: flag(i, "bk_figures_present") })
        : ((rt.store.get("payoff_quote_gates", quoteId)?.data as ReturnType<typeof accuracyGate> | undefined) ?? null);
      // "statement render": arms the accuracy gate (7.6) and the wire-verification gate, carrying every fact their evaluators read, before anything is rendered
      ctx.events.append({ type: "notice.render_requested", loanId, actor: ctx.actor, payload: { template: STATEMENT_TEMPLATE, quote_id: quoteId, statement_hash: String(q.hash ?? ""), wire_instruction_version_id: str(i, "wire_instruction_version_id") || null, active_vault_version_id: activeVersion, verification_token: token, wire_instruction_source: source,
        minted_token: minted?.token ?? null, minted_statement_hash: minted?.statement_hash ?? null, minted_wire_instruction_version_id: minted?.wire_instruction_version_id ?? null, minted_issued_at: minted?.issued_at ?? null,
        calc_version_current: String(q.calc_version ?? "") === CALC_VERSION, no_pending_items_older_than_cutoff: acc !== null && !acc.reasons.some((r) => /unposted|reversal/.test(r)), arm_adjustment_reflected: acc !== null && !acc.reasons.some((r) => /rate segments/.test(r)) } });
      const block: (gate: string, reason: string | null, alertTo: string | null) => never = (gate, reason, alertTo) => { ctx.events.append({ type: "payoff.statement.render_blocked", loanId, actor: ctx.actor, payload: { gate, quote_id: quoteId, reason, alert_to: alertTo } }); throw new RangeError(`${gate} closed: ${reason}`); };
      if (!g.open) {
        if (g.alert) rt.escalations.open({ kind: g.alert.kind, ownerRole: g.alert.to, severity: g.alert.severity, loanId, payload: { signal: g.alert.signal, gate: g.gate, quote_id: quoteId, wire_instruction_version_id: str(i, "wire_instruction_version_id") || null, active_vault_version_id: activeVersion, verification_token: token, never_approved: true, reason: g.reason } }, ctx.actor);
        block(g.gate, g.reason, g.alert?.to ?? null);
      }
      if (!acc) block("SM_PAYOFF_STMT_ACCURACY_GATE", `not asserted for quote ${quoteId} (assertAccuracyGate: ledger clean; no pending reversal; rate segments final; firm/BK figures present)`, null);
      if (!acc.open) block("SM_PAYOFF_STMT_ACCURACY_GATE", acc.refusal ?? acc.reasons.join("; "), null);
      const state = str(i, "state") || String(q.state ?? "OH"); const goodThrough = D(String(q.good_through)); const validUntil = D(String(q.valid_until ?? q.good_through));
      const request = q.request_id ? rt.store.get("payoff_requests", String(q.request_id))?.data ?? null : null;
      const variant = stateVariant(state, { valid_until: validUntil, good_through: goodThrough, closing_date: optDate(i, "closing_date"), payment_cutoff_hhmm: str(i, "payment_cutoff_hhmm") || null, payment_place: str(i, "payment_place") || null });
      const escrow = escrowParagraph({ escrow_balance_cents: cents(i.escrow_balance_cents), good_through: goodThrough, scheduled_disbursements: (i.scheduled_disbursements as ScheduledDisbursement[] | undefined) ?? [] });
      const alt = q.alt_figures as ReturnType<typeof alternativeFigures16> | null | undefined;
      const id = str(i, "statement_id") || `ps-${quoteId}`;
      const rec = rt.store.put("payoff_statements", id, { loan_id: loanId, quote_id: quoteId, request_id: q.request_id ?? null, requester_type: request ? String(request.requester_type) : null, template_code: STATEMENT_TEMPLATE, state, state_variant: variant.variant, state_text: variant.state_text, wire_instruction_version_id: str(i, "wire_instruction_version_id"), verification_token: token, verify_path: minted ? `/verify/${minted.token}` : null,
        valid_until: validUntil, good_through: goodThrough, rendered_on: now, escrow_balance_cents: cents(i.escrow_balance_cents), escrow_paragraph: escrow.text, escrow_cutoff_on: escrow.cutoff_on, borrower_to_pay: escrow.borrower_to_pay, alternative_text: alt?.applies ? alt.text : null,
        hsa_note: flag(i, "hsa_note_flag") ? "Your HomeSaver Advance note is due and payable in full on sale or transfer; on a refinance it continues to be paid and its payoff is not required to release the first lien (C-1.2-03)." : null, buydown_credit_cents: cents(q.buydown_credit_cents),
        total_cents: q.total_cents, per_diem_cents: q.per_diem_cents, hash: q.hash, accuracy_gate: { open: acc.open, forced: acc.forced, reasons: acc.reasons }, status: "rendered", delivered_to: [], sent_on: null, superseded_by: null }, ctx.actor, ctx.now);
      ctx.events.append({ type: "payoff.statement.rendered", loanId, aggregate: { kind: "payoff_statement", id }, actor: ctx.actor, payload: { statement_id: id, quote_id: quoteId, state_variant: variant.variant, verification_token: token } });
      return rec.data;
    }),
    guardrails: [
      never("FIGURES_FROM_QUOTES_ONLY", "16.1 guardrail: figures only from `payoff_quotes`; `human_agent` may annotate but not alter figures", (i) => i.figure_overrides !== undefined || i.total_cents !== undefined || i.interest_cents !== undefined || i.per_diem_cents !== undefined, "render from the quote_id; figures are never supplied inline"),
      never("WIRE_FROM_VAULT_ONLY", "16.1 guardrail: wire instructions only from the vault's active version", (i) => i.wire_instructions !== undefined || (str(i, "wire_instruction_source") !== "" && str(i, "wire_instruction_source") !== "vault"), "inline or e-mailed wire instructions are never rendered — a fraud signal for security-records (use escalate)"),
    ] },
  { name: "mintVerificationToken", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "statement_hash", "wire_instruction_version_id");
      const t = mintVerificationToken({ statement_hash: str(i, "statement_hash"), wire_instruction_version_id: str(i, "wire_instruction_version_id"), issued_at: ctx.now });
      rt.store.put("payoff_verification_tokens", t.token, { token: t.token, ...t.binds, loan_id: str(i, "loan_id") || null, verify_path: t.verify_path }, ctx.actor, ctx.now);
      ctx.events.append({ type: "payoff.verification_token.minted", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, actor: ctx.actor, payload: { token: t.token, ...t.binds } });
      return t;
    }) },
  // ---- delivery through the Notice Registry (7.6 layer): the statement is built from the payoff_quotes / payoff_statements rows
  { name: "sendNotice", kind: "act", handler: compute(async (i, ctx, rt) => {
      need(i, "loan_id", "template_code", "recipients");
      const loanId = str(i, "loan_id"); const template = str(i, "template_code"); const recipients = recipientsOf(i); const now = today(ctx.now);
      if (recipients.length === 0) throw new RangeError("recipients must name at least one party/channel");
      const updated = template === "NTC_PAYOFF_UPDATED_STMT" || flag(i, "updated"); const sid = str(i, "statement_id");
      let payload = ((i.payload as Record<string, unknown> | undefined) ?? {}); let state = str(i, "state") || null;
      let allPrior: boolean | null = null; let priorCount = 0; let statementRow: Record<string, unknown> | null = null; let updateRow: Record<string, unknown> | null = null;
      if (STATEMENT_TEMPLATES.test(template)) {
        const inline = inlineFigures(i); if (inline.length) throw new RangeError(`payload.${inline[0]} is a figure: figures come only from payoff_quotes (16.1 guardrail)`);
        if (updated) {
          // "to all prior recipients": an updated statement must reach every party/channel the original was delivered to
          updateRow = sid ? rt.store.get("payoff_statement_updates", sid)?.data ?? null : null;
          if (!updateRow) throw new RangeError(`updated statement ${sid || "(no statement_id)"}: no payoff_statement_updates row — scheduleRecompute produces the updated figure (figures only from payoff_quotes)`);
          const originalId = str(i, "original_statement_id") || String(updateRow.statement_id);
          const original = rt.store.get("payoff_statements", originalId)?.data ?? null; if (!original) throw new RangeError(`no payoff_statements row ${originalId} for the updated statement`);
          const prior = ((original.delivered_to as { party_id: string; channel: string }[] | undefined) ?? []);
          const cover = updatedStatementRecipients({ prior, proposed: recipients }); allPrior = cover.all_prior_recipients; priorCount = cover.prior_count;
          if (!cover.all_prior_recipients) throw new RangeError(`updated statement must go to every prior recipient (SM_PAYOFF_STMT_UPDATE_1BD); missing: ${cover.missing.map((m) => `${m.party_id}/${m.channel}`).join(", ") || "(the original was delivered to nobody)"}`);
          const uq = rt.store.get("payoff_quotes", String(updateRow.quote_id))?.data ?? null; if (!uq) throw new RangeError(`no payoff_quotes row ${String(updateRow.quote_id)} for the updated statement`);
          statementRow = original; state = state ?? (original.state as string | null) ?? null;
          payload = updatedStatementPayload({ updated_quote: { good_through: D(String(uq.good_through)), total_cents: cents(uq.total_cents), per_diem_cents: cents(uq.per_diem_cents) }, previous_total_cents: cents(updateRow.previous_total_cents), original_sent_on: D(String(original.sent_on ?? original.rendered_on ?? now)), change_date: D(String(updateRow.change_date)), explanation: String(updateRow.explanation), display: payload });
        } else {
          if (!sid) throw new RangeError("statement_id is required: the statement renders from its payoff_statements row (renderStatement first)");
          statementRow = rt.store.get("payoff_statements", sid)?.data ?? null; if (!statementRow) throw new RangeError(`no payoff_statements row ${sid} (renderStatement first)`);
          if (statementRow.status !== "rendered" && statementRow.status !== "sent") throw new RangeError(`statement ${sid} is ${String(statementRow.status)}: a superseded, expired or closed statement is never sent again`);
          const q = rt.store.get("payoff_quotes", String(statementRow.quote_id))?.data ?? null; if (!q) throw new RangeError(`no payoff_quotes row ${String(statementRow.quote_id)} for statement ${sid}`);
          const request = statementRow.request_id ? rt.store.get("payoff_requests", String(statementRow.request_id))?.data ?? null : null;
          state = state ?? String(statementRow.state);
          // no statement to an unverified third party without a borrower-of-record copy (7.6) — from the request row, not the caller's say-so
          const guard = thirdPartyStatementGuard({ requester_type: request ? String(request.requester_type) : (str(i, "requester_type") || null), requester_verified: request ? request.requester_verified === true : flag(i, "requester_verified"), recipients, borrower_party_ids: request && Array.isArray(request.borrower_party_ids) ? (request.borrower_party_ids as string[]) : borrowerIds(i) });
          if (!guard.allowed) throw new RangeError(`NO_UNVERIFIED_THIRD_PARTY: ${guard.reason}`);
          payload = statementPayload({ quote: q as unknown as QuoteRowFigures, statement: { state, state_text: (statementRow.state_text as string | null) ?? null, escrow_balance_cents: cents(statementRow.escrow_balance_cents), escrow_paragraph: String(statementRow.escrow_paragraph ?? ""), hsa_note: (statementRow.hsa_note as string | null) ?? null, verification_token: (statementRow.verification_token as string | null) ?? null, verify_path: (statementRow.verify_path as string | null) ?? null, rendered_on: D(String(statementRow.rendered_on ?? now)), valid_until: D(String(statementRow.valid_until)) },
            request: request ? { received_on: D(String(request.received_on)), reasonable_time_reason: String(request.reasonable_time_reason ?? "none"), reasonable_time_evidence_document_id: (request.reasonable_time_evidence_document_id as string | null) ?? null } : null, sent_on: now, display: payload });
          const vault = rt.store.get("payoff_wire_instructions", String(statementRow.wire_instruction_version_id ?? ""))?.data ?? null;
          if (vault) payload = { ...payload, wire_bank: vault.bank_name, wire_aba: vault.aba, wire_account_masked: `****${String(vault.account_last4 ?? "")}` };
        }
      }
      const svc = rt.notices; let noticeId: string | null = null; let checklistPassed: boolean | null = null; let payloadHash: string | null = null;
      if (svc) {
        const n = svc.render({ templateCode: template, loanId, recipients: recipients.map(toRecipient), payload, asOf: now });
        const sent = await svc.send(n.id, (i.channel_context as Parameters<typeof svc.send>[1] | undefined) ?? {});
        if (sent.status !== "sent") throw new RangeError(`notice ${n.id} (${template}) was not sent: ${sent.heldReason ?? sent.status}`);
        noticeId = sent.id; checklistPassed = sent.checklist.passed; payloadHash = sent.payloadHash;
      }
      const common = { template, notice_id: noticeId, statement_id: sid || null, recipients: recipients.map((r) => ({ party_id: r.party_id, channel: r.channel })), sequence: str(i, "sequence") || null, updated, state };
      ctx.events.append({ type: "notice.sent", loanId, actor: ctx.actor, payload: common });
      if (STATEMENT_TEMPLATES.test(template)) {
        const evidence = str(i, "delivery_evidence_document_id") || null;
        if (statementRow && !updated) rt.store.put("payoff_statements", sid, { ...statementRow, status: "sent", sent_on: statementRow.sent_on ?? now, notice_id: statementRow.notice_id ?? noticeId, delivered_to: [...((statementRow.delivered_to as unknown[] | undefined) ?? []), ...recipients.map((r) => ({ party_id: r.party_id, channel: r.channel, ...(r.email ? { email: r.email } : {}), ...(r.address ? { address: r.address } : {}), sent_at: ctx.now, notice_id: noticeId, evidence_document_id: evidence }))] }, ctx.actor, ctx.now);
        if (updateRow) rt.store.put("payoff_statement_updates", sid, { ...updateRow, status: "sent", sent_on: now, notice_id: noticeId, delivered_to: recipients.map((r) => ({ party_id: r.party_id, channel: r.channel, ...(r.email ? { email: r.email } : {}), ...(r.address ? { address: r.address } : {}), sent_at: ctx.now, notice_id: noticeId, evidence_document_id: evidence })) }, ctx.actor, ctx.now);
        ctx.events.append({ type: "payoff.statement.sent", loanId, actor: ctx.actor, payload: { ...common, all_prior_recipients: allPrior ?? false, prior_recipient_count: priorCount, sent_on: now } });
        if (evidence) ctx.events.append({ type: "payoff.statement.delivered", loanId, actor: ctx.actor, payload: { ...common, evidence_document_id: evidence, received_at: str(i, "received_at") || ctx.now } });
      }
      if (template === "NTC_FNMA_NIB_BALANCE_NOTICE" && str(i, "sequence") === "second") ctx.events.append({ type: "payoff.nib_maturity.resolved", loanId, actor: ctx.actor, payload: { outcome: "second_notice_sent", notice_id: noticeId, template } });
      if (template === "NTC_PAYOFF_AUTHORIZATION_REQUEST") {
        const rid = str(i, "request_id"); const req = rid ? rt.store.get("payoff_requests", rid)?.data ?? null : null;
        if (req) rt.store.put("payoff_requests", rid, { ...req, authorization_request_sent_at: ctx.now, status: "authorization_requested" }, ctx.actor, ctx.now);
        ctx.events.append({ type: "payoff.request.third_party.resolved", loanId, actor: ctx.actor, payload: { outcome: "authorization_request_sent", request_id: rid || null, notice_id: noticeId } });
      }
      return { ...common, all_prior_recipients: allPrior, sent_at: ctx.now, checklist_passed: checklistPassed, payload_hash: payloadHash, payload: bigs(payload) };
    }),
    guardrails: [
      never("FIGURES_FROM_QUOTES_ONLY", "16.1 guardrail: figures only from `payoff_quotes` — the statement renders from its rows, the agent supplies display fields only", (i) => STATEMENT_TEMPLATES.test(str(i, "template_code")) && inlineFigures(i).length > 0, "drop the figure keys from payload; name statement_id (renderStatement / scheduleRecompute produce the figures)"),
      never("NO_UNVERIFIED_THIRD_PARTY", "16.1 guardrail (7.6): no statement to an unverified third party without a borrower-of-record copy", (i) => STATEMENT_TEMPLATES.test(str(i, "template_code")) && isThirdParty(str(i, "requester_type")) && !flag(i, "requester_verified") && !recipientsOf(i).some((r) => borrowerIds(i).includes(r.party_id)), "verify the requester (SM_PAYOFF_THIRD_PARTY_AUTH_1BD) or add the borrower-of-record copy"),
      never("NO_LOOKALIKE_DOMAIN", "16.1 edge case: no statement e-mail to look-alike domains; suspected requester fraud → security-records", (i) => flag(i, "lookalike_domain"), "verify by callback to an independently sourced number"),
    ] },
  // ---- SM_PAYOFF_STMT_UPDATE_1BD / FL_701_04_CORRECTED_ESTOPPEL_CUTOFF: the recompute runs the calculator on the post-event ledger facts
  { name: "scheduleRecompute", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "loan_id", "statement_id", "trigger_event", "occurred_on", "ledger_snapshot_id");
      const loanId = str(i, "loan_id"); const sid = str(i, "statement_id"); const now = optDate(i, "today") ?? today(ctx.now);
      const stored = rt.store.get("payoff_statements", sid)?.data ?? null; if (!stored) throw new RangeError(`no payoff_statements row ${sid}: a recompute updates an issued statement`);
      const quoteId = String(stored.quote_id); const quote = rt.store.get("payoff_quotes", quoteId)?.data ?? null; if (!quote) throw new RangeError(`no payoff_quotes row ${quoteId} behind statement ${sid}`);
      const statement: ActiveStatement = { id: sid, sent_on: D(String(stored.sent_on ?? stored.rendered_on ?? now)), good_through: D(String(stored.good_through)), total_cents: cents(stored.total_cents), recipients: ((stored.delivered_to as { party_id: string; channel: string; email?: string; address?: string }[] | undefined) ?? []).map((d) => ({ party_id: d.party_id, channel: d.channel, ...(d.email ? { email: d.email } : {}), ...(d.address ? { address: d.address } : {}) })) };
      // the calculator on the post-event ledger: the original components with the stated changes (a reversed installment restores the UPB and LPI, a fee assessment adds its line …), the same ledger snapshot discipline as the original
      const merged = recomputedComponents(quote.components as Components, componentChanges(i)); const rates = (i.rate_segments as RateInForce[] | undefined) ?? (quote.rate_segments_in_force as RateInForce[] | null | undefined) ?? null;
      const row = payoffQuoteRow({ components: merged, rates, ledger_snapshot_id: str(i, "ledger_snapshot_id"), fee_waiver_cents: cents(quote.fees_waived_cents) });
      const reason = str(i, "reason");
      const r = recomputeOnEvent({ statement, trigger: { event: str(i, "trigger_event") as "payment.reversed", occurred_on: date(i, "occurred_on"), description: reason }, today: now, new_total_cents: row.total_cents });
      if (!r.recompute) return { ...r, quote_id: null, recomputed_total_cents: row.total_cents };
      const newId = `${quoteId}-u${rt.store.list("payoff_quotes", (d) => d.supersedes_quote_id === quoteId).length + 1}`;
      rt.store.put("payoff_quotes", newId, { loan_id: loanId, request_id: quote.request_id ?? null, quote_type: "updated", calc_at: ctx.now, state: quote.state ?? stored.state ?? null, ...row.figures, components: row.components, rate_segments_in_force: rates, fees_waived_reason: quote.fees_waived_reason ?? null, escrow_treatment: quote.escrow_treatment ?? "refund_separately", valid_until: quote.valid_until ?? stored.valid_until ?? null, good_through_capped: quote.good_through_capped ?? false, alt_figures: null,
        deadlines: quote.deadlines ?? null, hash: row.hash, rule_set: "16.1@rules.v1", supersedes_quote_id: quoteId, reason: reason || null, trigger_event: str(i, "trigger_event"), occurred_on: str(i, "occurred_on"), statement_id: sid, superseded_by_id: null }, ctx.actor, ctx.now);
      ctx.events.append({ type: "payoff.quote.recompute", loanId, aggregate: { kind: "payoff_quote", id: newId }, actor: ctx.actor, payload: { statement_id: sid, quote_id: newId, supersedes_quote_id: quoteId, delta: r.delta_cents.toString(), delta_cents: r.delta_cents.toString(), total_cents: row.total_cents.toString(), previous_total_cents: statement.total_cents.toString(), trigger: str(i, "trigger_event"), occurred_on: str(i, "occurred_on"), reason: reason || null, hash: row.hash } });
      if (r.updated) {
        // a Δ ≠ 0 supersedes the original quote (back-link only — payoff_quotes stay append-only) and the statement; the update goes to every prior recipient within 1 BD
        rt.store.put("payoff_quotes", quoteId, { ...quote, superseded_by_id: newId }, ctx.actor, ctx.now);
        const state = str(i, "state") || (stored.state as string | undefined) || null; const paymentDate = optDate(i, "payment_date") ?? statement.good_through;
        rt.store.put("payoff_statement_updates", r.updated.id, { updated_statement_id: r.updated.id, statement_id: sid, loan_id: loanId, quote_id: newId, template: r.updated.template, total_cents: r.updated.total_cents, previous_total_cents: r.updated.previous_total_cents, delta_cents: r.delta_cents, explanation: r.updated.explanation, send_to: r.updated.send_to, due_by: r.updated.due_by, change_date: str(i, "occurred_on"), state, payment_date: paymentDate, status: "pending" }, ctx.actor, ctx.now);
        rt.store.put("payoff_statements", sid, { ...stored, status: "superseded", superseded_by: r.updated.id }, ctx.actor, ctx.now);
        ctx.events.append({ type: "payoff.statement.superseded", loanId, actor: ctx.actor, payload: { statement_id: sid, superseded_by: r.updated.id, quote_id: newId, due_by: r.updated.due_by, recipients: r.updated.send_to.length } });
        ctx.events.append({ type: "payoff.statement.updated", loanId, actor: ctx.actor, payload: { statement_id: sid, updated_statement_id: r.updated.id, quote_id: newId, state, payment_date: paymentDate, due_by: r.updated.due_by, delta_cents: r.delta_cents.toString(), explanation: r.updated.explanation } });
      }
      return { ...r, quote_id: newId, recomputed_total_cents: row.total_cents, recomputed_per_diem_cents: row.per_diem_cents, hash: row.hash };
    }),
    guardrails: [
      never("FIGURES_FROM_QUOTES_ONLY", "16.1 guardrail: figures only from `payoff_quotes` — a recompute runs the calculator on the ledger facts, it never takes a total", (i) => i.new_total_cents !== undefined || i.total_cents !== undefined || i.interest_cents !== undefined, "state the ledger facts after the event (upb_cents, lpi_due, late_charges_cents, …) and the ledger_snapshot_id; the engine computes the figure"),
      never("RECOMPUTE_DELTA_EXPLAINED", "16.1 guardrail: every recompute Δ is explained in the updated statement", (i) => !str(i, "reason"), "state the reason (e.g. 'the September 1 installment was reversed (returned unpaid)') — the bare trigger event is not an explanation"),
    ] },
  // ---- 16.2 shortage path with the rule-10 reliance overlay and the example-A funds events (figures only from the quote the payer relied on)
  { name: "openShortagePath", kind: "act", handler: compute((i, ctx, rt) => {
      need(i, "loan_id", "quote_id", "received_on", "amount_received_cents");
      const loanId = str(i, "loan_id"); const q = rt.store.get("payoff_quotes", str(i, "quote_id"))?.data ?? null; if (!q) throw new RangeError(`no payoff_quotes row ${str(i, "quote_id")} — figures come only from payoff_quotes`);
      const state = String(q.state ?? str(i, "state") ?? "OH");
      const r = fundsReceived({ components: q.components as Components, statement_total_cents: cents(q.total_cents), per_diem_cents: cents(q.per_diem_cents), received_on: date(i, "received_on"), amount_received_cents: cents(i.amount_received_cents), state, installment_due_on: optDate(i, "installment_due_on") });
      // rule 10: in FL/TX/CA a figure that was low is absorbed — a demand for more from the party that relied on it through good-through/closing is refused by the engine
      const demandBlocked = r.disposition === "servicer_absorbed";
      if (flag(i, "demand") && demandBlocked) throw new RangeError(`NO_DEMAND_AFTER_RELIANCE: ${state} figure ${cents(q.total_cents)} relied on through ${String(q.good_through)} — shortage ${r.shortage_cents} is servicer_absorbed (16.2), never demanded`);
      ctx.events.append({ type: r.event.type, loanId, actor: ctx.actor, payload: { ...bigs(r.event.payload as Record<string, unknown>), quote_id: str(i, "quote_id"), state, payoff_date: r.payoff_date, exact_total_cents: r.exact_total_cents.toString(), amount_received_cents: cents(i.amount_received_cents).toString(), demand_blocked: demandBlocked, statement_hash: String(q.hash ?? "") } });
      if (r.paid_in_full_on) ctx.events.append({ type: "loan.paid_in_full", loanId, actor: ctx.actor, payload: { payoff_date: r.paid_in_full_on, quote_id: str(i, "quote_id"), rounding_expense_cents: r.rounding_expense_cents.toString(), absorbed_shortage_cents: (demandBlocked ? r.shortage_cents : 0n).toString() } });
      return { ...r, state, demand_blocked: demandBlocked };
    }),
    guardrails: [
      never("FIGURES_FROM_QUOTES_ONLY", "16.1 guardrail: figures only from `payoff_quotes` — the funds are matched against the quote the payer relied on", (i) => i.exact_total_cents !== undefined || i.statement_total_cents !== undefined || i.per_diem_cents !== undefined, "name the quote_id; the exact figure is recomputed from its components"),
      never("NO_DEMAND_AFTER_RELIANCE", "16.1 rule 10: in FL/TX/CA a figure that was low is absorbed by Supermortgage, never demanded from a party that relied on it", (i) => flag(i, "demand") && RELIANCE_STATES.has(str(i, "state")) && (flag(i, "within_good_through") || (str(i, "received_on") !== "" && str(i, "good_through") !== "" && str(i, "received_on") <= str(i, "good_through"))), "shortage → servicer_absorbed"),
    ] },
  { name: "recordDecision", kind: "write", handler: compute((i, ctx) => {
      const out = decision()(i, ctx);
      // A4-2.1-07 "attempt to contact": the recorded contact outcome resolves the second-notice window (FNMA_A42107_NIB_MATURITY_NOTICE_75_60)
      if (str(i, "action") === "nib_maturity.contact_established") ctx.events.append({ type: "payoff.nib_maturity.resolved", loanId: (i.loan_id as string | undefined) ?? ctx.loanId, actor: ctx.actor, payload: { outcome: "contact_established", contact_on: str(i, "contact_on") || ctx.now.slice(0, 10), channel: str(i, "channel") || null, rationale: str(i, "rationale") || null } });
      return out;
    }), decision: (i) => ({ action: str(i, "action") || "recordDecision", rationale: str(i, "rationale") || "payoff-release decision record" }) },
  { name: "escalate", kind: "act", handler: compute((i, ctx, rt) => {
      const loanId = (i.loan_id as string | undefined) ?? ctx.loanId;
      if (str(i, "reason_kind") === "non_vault_wire_instruction") return rt.escalations.open({ kind: "fraud_officer", ownerRole: "security-records", severity: "sev1", loanId, payload: { signal: "non_vault_wire_instruction", never_approved: true, requested_by: str(i, "requested_by") || null, reason: str(i, "reason") || "request to send a statement with a non-vault wire instruction" } }, ctx.actor);
      if (str(i, "reason_kind") === "statement_deadline_breach") {
        // a breached REGZ_1026_36C3_PAYOFF_STMT_7BD / STATE_PAYOFF_STMT_DEADLINE: sev-1 with the state exposure log; CT's `interest_forfeit_if_late` opens a qc_finding case carrying the interest forfeited from the request date
        need(i, "loan_id", "state", "request_on");
        const q = str(i, "quote_id") ? rt.store.get("payoff_quotes", str(i, "quote_id"))?.data ?? null : null;
        const segs = (q?.rate_segments as { rate_pct: string }[] | undefined) ?? [];
        const b = statementDeadlineBreach({ state: str(i, "state"), request_on: date(i, "request_on"), sent_on: optDate(i, "sent_on"), today: optDate(i, "today") ?? today(ctx.now), upb_cents: q ? cents(q.upb_cents) : cents(i.upb_cents), rate_pct: q ? String(segs[segs.length - 1]?.rate_pct ?? (q.components as Components).rate_pct) : str(i, "rate_pct"), requested_payoff_on: optDate(i, "requested_payoff_on"), due_on: optDate(i, "due_on") });
        if (!b.breached) return { ...b, escalation_id: null, case_id: null };
        const esc = rt.escalations.open({ kind: "sev1", ownerRole: "officer", severity: "sev1", loanId, payload: { timer: b.timer, timers_breached: [...b.timers_breached], governing: b.governing, due_on: b.due_on, exposure: b.exposure, state: str(i, "state"), request_on: str(i, "request_on"), sent_on: str(i, "sent_on") || null, quote_id: str(i, "quote_id") || null } }, ctx.actor);
        let caseId: string | null = null;
        if (b.case) {
          caseId = `qc-${loanId}-${b.timer}-${b.due_on}`;
          rt.store.put("cases", caseId, { kind: "qc_finding", case_type: "qc_finding", source: "16.1", loan_id: loanId, timer: b.timer, timers_breached: [...b.timers_breached], due_on: b.due_on, state: str(i, "state"), reason: b.case.reason, interest_forfeited_from: b.case.interest_forfeited_from, per_diem_cents: b.case.per_diem_cents, status: "open", root_cause_required: true, escalation_id: esc.id }, ctx.actor, ctx.now);
          ctx.events.append({ type: "case.opened", loanId, aggregate: { kind: "case", id: caseId }, actor: ctx.actor, payload: { case_id: caseId, kind: "qc_finding", source: "16.1", timer: b.timer, due_on: b.due_on, interest_forfeited_from: b.case.interest_forfeited_from, per_diem_cents: b.case.per_diem_cents.toString(), reason: b.case.reason, escalation_id: esc.id } });
        }
        return { ...b, escalation_id: esc.id, case_id: caseId };
      }
      const kind = (str(i, "kind") || "officer") as EscalationKind;
      return escalate(kind)(i, ctx, rt);
    }),
    guardrails: [never("NON_VAULT_WIRE_NEVER_APPROVED", "16.1 escalations: a request to send a statement with a non-vault wire instruction is never approved — logged as a fraud signal to security-records", (i) => str(i, "reason_kind") === "non_vault_wire_instruction" && flag(i, "request_approval"), "approval is not a path; the signal is logged for security-records"),
      never("OFFICER_SIMILAR_CIRCUMSTANCES", "16.1 escalations: only the officer approves a 'similar circumstances' reasonable-time category", (i) => str(i, "reason_kind") === "reasonable_time_similar" && str(i, "kind") !== "" && str(i, "kind") !== "officer", "route to the officer")] },
]);
