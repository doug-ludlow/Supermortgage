/**
 * §18.1 tools — the spec's tool strings for process 18.1, verbatim, via
 * `defineTools("18.1", "qc-audit", defs)` from ../tools.ts (see section13.ts). Spread by ./section18.ts.
 * The Agents paragraph: "execute rederive/checklist tests via tools (`ledger.recompute`,
 * `escrow.recompute_analysis`, `arm.second_engine`, `notice.checklist`, `timers.history`,
 * `investor_events.replay`)". Allowlist: "read-only SQL over projections and immutable logs;
 * recompute engines; document retrieval … Never: write to operational tables, post ledger
 * entries (remediation entries are posted by the owning agent from the CAPA), send borrower
 * communications, or change rule sets." Every tool here is a read: it computes an expected
 * value and compares; the guardrails refuse the write-shaped uses of each.
 */
import { defineTools, compute, never, cents, str, num, flag, type ToolDef, type ToolInput } from "../tools.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { RateInputs } from "../../domain/notices/arm.ts";
import { rederivePaymentAllocation, rederiveEscrowCushion, rederiveArmAdjustment, noticeChecklistTest, timerHistory, replayInvestorEvents, type BucketCents } from "../../domain/qc-audit/ops-18-1.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import type { NoticeRegistry } from "../../notices/registry.ts";

const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const AGENT = "qc-audit";
const ALLOWLIST = "18.1 tools allowlist: read-only over projections and immutable logs; never write to operational tables, post ledger entries, send borrower communications, or change rule sets";
const buckets = (v: unknown): BucketCents => { const o = (v ?? {}) as Record<string, unknown>; return { interest_cents: cents(o.interest_cents), principal_cents: cents(o.principal_cents), escrow_cents: cents(o.escrow_cents), late_charge_cents: cents(o.late_charge_cents) }; };
let noticeRegistry: NoticeRegistry | null = null;
const registry = (): NoticeRegistry => { if (!noticeRegistry) { noticeRegistry = buildRegistry(); publishAuthored(noticeRegistry); } return noticeRegistry; };
const writeShaped = (i: ToolInput): boolean => i.op === "write" || i.op === "post" || i.op === "apply" || i.changes !== undefined;

export const TOOLS_18_1: readonly ToolDef[] = defineTools("18.1", AGENT, [
  // Rule A `QC_PAY_ALLOCATION_RECOMPUTE`: an independent C-1.1-01 waterfall over the amounts due, compared bucket by bucket with the posted allocation.
  { name: "ledger.recompute", kind: "read", handler: compute((i) => { need(i, "subject_id", "amount_cents", "due", "observed"); const profile = str(i, "profile") === "pre_1999" ? "pre_1999" as const : "uniform_1999_plus" as const; const obs = i.observed as Record<string, unknown>; return rederivePaymentAllocation({ subject_id: str(i, "subject_id"), profile, amount_cents: cents(i.amount_cents), due: buckets(i.due), observed: { ...buckets(obs), suspense_cents: cents(obs.suspense_cents) } }); }),
    guardrails: [never("NO_LEDGER_POST", `${ALLOWLIST} — remediation entries are posted by the owning agent from the CAPA`, (i) => writeShaped(i) || flag(i, "post") || i.entry_set !== undefined, "draft the reversing/correcting entry set in the finding dossier; the owning agent posts it from the CAPA")] },
  // Rule A/C `QC_ESCROW_ANALYSIS_RECOMPUTE`: the Appendix E cushion (policy months, 1/6 cap) re-derived from the year's disbursements by the QC module's own `appendixECushion`, not the escrow engine's `cushion()`.
  { name: "escrow.recompute_analysis", kind: "read", handler: compute((i) => { need(i, "subject_id", "annual_disbursements_cents", "observed_cushion_cents"); const c = (i.cushion as Record<string, unknown> | undefined) ?? {}; return rederiveEscrowCushion({ subject_id: str(i, "subject_id"), annual_disbursements_cents: cents(i.annual_disbursements_cents), observed_cushion_cents: cents(i.observed_cushion_cents), cushion: { ...(c.policy_months !== undefined ? { policy_months: Number(c.policy_months) } : {}), ...(c.instrument_months !== undefined ? { instrument_months: c.instrument_months === null ? null : Number(c.instrument_months) } : {}), ...(c.state_max_months !== undefined ? { state_max_months: c.state_max_months === null ? null : Number(c.state_max_months) } : {}), ...(c.instrument_dollars_cents !== undefined ? { instrument_dollars_cents: c.instrument_dollars_cents === null ? null : cents(c.instrument_dollars_cents) } : {}) } }); }),
    guardrails: [never("STATEMENT_ISSUED_BY_ESCROW", "18.1-T2: the corrected statement is issued by `escrow` (not by `qc-audit`); " + ALLOWLIST, (i) => writeShaped(i) || flag(i, "issue_statement") || flag(i, "correct_analysis"), "open the CAPA `re_notice`/`refund`; the escrow agent recomputes the shortage spread and issues the corrected annual statement")] },
  // Rule A `QC_ARM_ADJ_RECOMPUTE` ("rederive vs second engine (7.2)"): 7.2's engine B `verifyArmAdjustment` (BigInt fixed-point, shares nothing with engine A `computeArmAdjustment` that production ran) — rate (index + margin, 1/8 rounding, caps, floor) and payment; 100% of cap-bound adjustments.
  { name: "arm.second_engine", kind: "read", handler: compute((i) => { need(i, "subject_id", "rate", "expected_upb_cents", "remaining_term", "observed"); const r = i.rate as Record<string, unknown>; const obs = i.observed as Record<string, unknown>; need(r, "index_pct", "margin_pct", "prior_rate_pct", "initial_note_rate_pct", "initial_cap_pct", "periodic_cap_pct", "lifetime_cap_pct"); need(obs, "new_rate_pct", "payment_cents");
      const rate: RateInputs = { index_pct: String(r.index_pct), margin_pct: String(r.margin_pct), prior_rate_pct: String(r.prior_rate_pct), initial_note_rate_pct: String(r.initial_note_rate_pct), initial_cap_pct: String(r.initial_cap_pct), periodic_cap_pct: String(r.periodic_cap_pct), lifetime_cap_pct: String(r.lifetime_cap_pct), first_change: r.first_change === true, ...(r.rounding === "half_up" || r.rounding === "half_down" ? { rounding: r.rounding } : {}) };
      return rederiveArmAdjustment({ subject_id: str(i, "subject_id"), rate, expected_upb_cents: cents(i.expected_upb_cents), remaining_term: num(i, "remaining_term"), interest_only: flag(i, "interest_only"), observed: { new_rate_pct: String(obs.new_rate_pct), payment_cents: cents(obs.payment_cents) } }); }),
    guardrails: [never("SECOND_ENGINE_NEVER_APPLIES", `${ALLOWLIST} — the second engine compares the adjustment, it never applies a rate or payment change (7.2 owns the adjustment and its correction)`, (i) => writeShaped(i) || flag(i, "apply") || flag(i, "correct_rate"), "record the variance on the qc_tests row; a failed rederive opens the finding and the 7.2 correction path")] },
  // Rule A `QC_NOTICE_CONTENT_CHECKLIST`: the Notice Registry checklist run over the rendered notice — content, layout and data rules of the template version in force on the send date.
  { name: "notice.checklist", kind: "read", handler: compute((i, ctx) => { need(i, "template_code", "payload"); const asOf: PlainDate = D(str(i, "as_of") || ctx.now.slice(0, 10)); const v = registry().activeVersion(str(i, "template_code"), asOf); if (!v) throw new RangeError(`no active version of ${str(i, "template_code")} on ${asOf}`); const payload = i.payload as Record<string, unknown>; const out = render(v.source, payload);
      return { ...noticeChecklistTest({ subject_id: str(i, "subject_id") || str(i, "notice_id") || `${str(i, "template_code")}@${asOf}`, template_code: str(i, "template_code"), checklist: evaluateChecklist(v, payload, out) }), payload_hash: out.payloadHash }; }),
    guardrails: [never("NO_BORROWER_COMMUNICATION", `${ALLOWLIST} — qc-audit never sends borrower communications; a corrected notice is produced by the owning section after a finding`, (i) => writeShaped(i) || i.op === "send" || flag(i, "send") || flag(i, "resend"), "open the CAPA `re_notice`; the owning section renders and sends through the Notice Registry")] },
  // Evidence: the immutable timer history for a subject — armed/due/satisfied/breached and whether satisfaction beat the due instant (timer histories are audit evidence, 18.2 productions).
  { name: "timers.history", kind: "read", handler: compute((i, ctx) => { need(i, "subject_id"); const kind = str(i, "subject_kind") || "loan"; const id = str(i, "subject_id"); const code = str(i, "code"); const instances = ctx.timers.forSubject(kind, id).filter((t) => !code || t.code === code); const ids = new Set(instances.map((t) => t.id));
      const events = ctx.events.all().filter((e) => e.type.startsWith("timer.") && (typeof e.payload.timer_id === "string" ? ids.has(e.payload.timer_id) : e.loanId === id)).map((e) => ({ id: e.id, type: e.type, occurredAt: e.occurredAt, payload: e.payload }));
      return { subject: { kind, id }, ...timerHistory(instances, events) }; }),
    guardrails: [never("TIMERS_READ_ONLY", `${ALLOWLIST} — timers are armed and cancelled by the owning process; satisfaction is event-driven`, (i) => i.op === "arm" || i.op === "cancel" || i.op === "satisfy" || writeShaped(i), "read the history; a timing failure is a qc_tests row and, past tolerance, a finding")] },
  // Rule A `QC_INVESTOR_EVENT_TIMELINESS`: replay the loan's investor-event log in sequence; every rejection must be followed by a correction or acceptance.
  { name: "investor_events.replay", kind: "read", handler: compute((i, ctx) => { need(i, "loan_id"); const loanId = str(i, "loan_id"); const from = str(i, "from"); const to = str(i, "to"); const events = ctx.events.byLoan(loanId).filter((e) => (!from || e.occurredAt.slice(0, 10) >= from) && (!to || e.occurredAt.slice(0, 10) <= to)).map((e) => ({ id: e.id, type: e.type, occurredAt: e.occurredAt, sequence: e.sequence, payload: e.payload }));
      return replayInvestorEvents({ loan_id: loanId, events }); }),
    guardrails: [never("REPLAY_NEVER_RESUBMITS", `${ALLOWLIST} — a replay re-derives from the immutable log; it never re-emits, resubmits or corrects an investor event (5.x owns the LAR) and never changes rule sets`, (i) => writeShaped(i) || flag(i, "emit") || flag(i, "resubmit") || flag(i, "correct") || i.rule_set_version_override !== undefined, "record the open rejection on the qc_tests row; the 5.x exception queue works the correction")] },
]);
