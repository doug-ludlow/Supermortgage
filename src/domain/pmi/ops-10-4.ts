/**
 * §10.4 process ops — the annual PMI disclosure cycle as real code paths, so the registry clocks arm on and close with
 * events this process actually appends (src/domain/pmi/timers-10-4.ts binds the patterns):
 *
 *   - `activateMiPolicy` — ingestion of the boarded MI policy record (Section 1.1 tape fields `pmi_last_annual_disclosure_on`
 *     …; the 10.2 boarding check's `mi_policies` row). It validates the inbound record and appends `mi_policy.activated`
 *     carrying the fields the 10.4 clocks condition on: `annual_disclosure` (R1: BPMI plan ∧ status active — LPMI gets
 *     none, 12 U.S.C. 4905(b)), `state` (the MN §47.207 override), `last_annual_disclosure_on` (null → the 60-day
 *     post-boarding policy clock, anchored on `boarded_at`) and `disclosure_anchor_on` = "the later of the last
 *     disclosure sent (transferor's date if boarded) or boarding date" — the anchor of HPA_4903A3_ANNUAL_DISCLOSURE_12M.
 *     `attachDisclosureHooks_10_4` runs it from `loan.boarded` when the boarding record carries the `mi` block (or the
 *     policy row is already on file); `runDisclosureSweep` activates any active BPMI policy the hooks missed.
 *   - `runDisclosureSweep` — the scheduler ("AI-off: the scheduler still composes and sends using the last approved
 *     template"): evaluates the clocks, handles a breached 12-month clock (auto-send standalone + `officer` sev-2 +
 *     Sentinel line — 10.4-T2) and, once a cycle is 70% elapsed, appends `mi.disclosure.due_approaching{elapsed_pct,
 *     disclosure_due_on}` which arms SM_MI_DISCLOSURE_COMPOSE_LEAD_30 (30 calendar days before due).
 *   - `composeDisclosure` — the composition step (state machine `scheduled` → `composed`): carrier selection (R2 —
 *     escrow statement in `[next_due − 120, next_due]`, else 1098, else standalone at `next_due − 15`), template by R1,
 *     the Notice Registry render + required-content checklist (a failed checklist holds the notice — it can never be
 *     released), the append-only `mi_disclosures` row and `mi.disclosure.composed` (closes the compose-lead clock).
 *   - `releaseDisclosure` — `composed` → `sent`: composition re-checks MI status at release (MI ended → the PMI page is
 *     suppressed and the 4904(a) notice is due within 30 days — 10.4-T7), sends through the Notice Registry (channel
 *     decision by E-SIGN consent — 10.4-T6), records `sent_at`/`channel`, re-anchors `last_annual_disclosure_on` /
 *     `next_annual_disclosure_due` on the policy and appends `mi.disclosure.sent`; the registry's `notice.sent{template}`
 *     closes (and re-arms) the 12-month clock.
 *   - `attachDisclosureHooks_10_4` — the ingestion subscriptions: `loan.boarded` (activation), `escrow.statement.sent`
 *     (the CA §2954.6 per-statement gate is a jurisdiction override: the instance the registry arms on every annual
 *     statement is cancelled the same day for a non-California property), `mi.terminated` / `mi.cancelled` /
 *     `mi.rescinded` (cancel the recurring cycle).
 */
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { TimerEngine, TimerInstance, Breach } from "../../kernel/timers/engine.ts";
import type { EscalationService } from "../../app/escalations.ts";
import type { EntityStore } from "../../app/tools.ts";
import type { NoticeService, Notice } from "../../notices/service.ts";
import type { Recipient } from "../../notices/channel.ts";
import { plainDate as D, type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { disclosurePlan, type DisclosurePlan } from "./disclosure.ts";
import { disclosureTemplateCode, disclosureReleaseCheck, type DisclosureCode } from "./ops.ts";

export const HPA_ANNUAL = "HPA_4903A3_ANNUAL_DISCLOSURE_12M";
export const MN_ANNUAL = "MN_47_207_ANNUAL_NOTICE_12M";
export const FIRST_60 = "SM_MI_FIRST_DISCLOSURE_POST_BOARDING_60";
export const COMPOSE_LEAD = "SM_MI_DISCLOSURE_COMPOSE_LEAD_30";
export const CA_STATEMENT = "CA_2954_6_NOTICE_WITH_STATEMENT";
/** R1: borrower-paid plans (financed single-premium BPMI included — "it is borrower-paid MI"). */
export const BPMI_PLANS_10_4: ReadonlySet<string> = new Set(["bpmi_monthly", "bpmi_annual", "bpmi_single", "bpmi_split", "financed_single", "bpmi_single_financed"]);
export const DISCLOSURE_CODES: ReadonlySet<string> = new Set(["NTC_HPA_4903A3_ANNUAL", "NTC_HPA_4903A3_ANNUAL_MN", "NTC_HPA_4903A3_ANNUAL_CA", "NTC_HPA_4903B_ANNUAL_LEGACY", "NTC_FNMA_MI_ANNUAL_INFO"]);
const DISCLOSURE_KIND: Record<DisclosureCode, string> = { NTC_HPA_4903A3_ANNUAL: "annual_a3", NTC_HPA_4903B_ANNUAL_LEGACY: "annual_b_legacy", NTC_HPA_4903A3_ANNUAL_MN: "mn_47_207", NTC_HPA_4903A3_ANNUAL_CA: "ca_2954_6", NTC_FNMA_MI_ANNUAL_INFO: "annual_a3" };
const PMI_AGENT: Actor = { kind: "agent", id: "pmi" };

export interface DisclosureDeps {
  readonly events: EventStore;
  readonly timers: TimerEngine;
  readonly store: EntityStore;
  readonly clock: { now(): string };
  readonly notices?: NoticeService;
  readonly escalations?: Pick<EscalationService, "open">;
  readonly actor?: Actor;
}

/** The boarded MI policy record after validation (Section 1.1 tape → `mi_policies`, 10.1 model). */
export interface MiPolicyRecord {
  readonly loan_id: string;
  readonly policy_id: string;
  readonly premium_plan: string;
  readonly status: string;
  readonly state: string | null;
  readonly consummation: PlainDate | null;
  readonly hpa_covered: boolean;
  readonly boarded_at: PlainDate;
  readonly last_annual_disclosure_on: PlainDate | null;
  readonly lpmi_equivalent_termination_date: PlainDate | null;
}

const todayOf = (deps: DisclosureDeps): PlainDate => wallClock(Date.parse(deps.clock.now()), "America/New_York").date;
const actorOf = (deps: DisclosureDeps): Actor => deps.actor ?? PMI_AGENT;
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const optDate = (v: unknown, field: string): PlainDate | null => {
  if (v === undefined || v === null || v === "") return null;
  if (isDate(v)) return D(v);
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return wallClock(Date.parse(v), "America/New_York").date;
  throw new RangeError(`${field} must be an ISO date, got ${String(v)}`);
};

/** Validate the inbound MI policy record (boarding `mi` block or `mi_policies` row); RangeError names the bad field. */
export function validateMiPolicyRecord(loanId: string, raw: Record<string, unknown>): MiPolicyRecord {
  if (!loanId) throw new RangeError("loan_id is required");
  const plan = String(raw.premium_plan ?? "");
  if (!plan) throw new RangeError("premium_plan is required");
  if (!BPMI_PLANS_10_4.has(plan) && plan !== "lpmi") throw new RangeError(`premium_plan ${plan} is not a known BPMI plan or lpmi`);
  const status = String(raw.status ?? "active");
  const boarded = optDate(raw.boarded_at, "boarded_at");
  if (!boarded) throw new RangeError("boarded_at is required");
  const state = raw.state === undefined || raw.state === null || raw.state === "" ? null : String(raw.state).toUpperCase();
  if (state !== null && !/^[A-Z]{2}$/.test(state)) throw new RangeError(`state ${state} is not a two-letter code`);
  return {
    loan_id: loanId, policy_id: String(raw.policy_id ?? raw.mi_policy_id ?? `mi-${loanId}`), premium_plan: plan, status, state,
    consummation: optDate(raw.consummation, "consummation"), hpa_covered: raw.hpa_covered !== false, boarded_at: boarded,
    last_annual_disclosure_on: optDate(raw.last_annual_disclosure_on ?? raw.pmi_last_annual_disclosure_on, "last_annual_disclosure_on"),
    lpmi_equivalent_termination_date: optDate(raw.lpmi_equivalent_termination_date, "lpmi_equivalent_termination_date"),
  };
}

/** R1 — `send_annual = premium_plan ∈ BPMI plans ∧ status='active'`. */
export const annualDisclosureRequired = (r: Pick<MiPolicyRecord, "premium_plan" | "status">): boolean => BPMI_PLANS_10_4.has(r.premium_plan) && r.status === "active";

/** Template for the policy (R1: legacy before 1999-07-29; state variant; Fannie Mae framing outside HPA scope; none for LPMI). */
export function disclosureTemplateFor(r: Pick<MiPolicyRecord, "premium_plan" | "consummation" | "hpa_covered" | "state">): DisclosureCode | null {
  return disclosureTemplateCode({ plan: r.premium_plan, consummation: r.consummation ?? D("1999-07-29"), hpa_covered: r.hpa_covered, state: r.state ?? "" });
}

/** Ingest the boarded MI policy: store the row and append `mi_policy.activated` (idempotent per policy). */
export function activateMiPolicy(deps: DisclosureDeps, rec: MiPolicyRecord): DomainEvent | null {
  const already = deps.events.byLoan(rec.loan_id).some((e) => e.type === "mi_policy.activated" && e.payload.policy_id === rec.policy_id);
  if (already) return null;
  const annual = annualDisclosureRequired(rec);
  const plan: DisclosurePlan | null = annual ? disclosurePlan({ last_sent: rec.last_annual_disclosure_on, boarded_on: rec.boarded_at, escrow_statement_on: null, form_1098_on: null }) : null;
  const anchor = rec.last_annual_disclosure_on ?? rec.boarded_at;   // "anchor = the later of the last disclosure sent (transferor's date if boarded) or boarding date"
  const template = annual ? disclosureTemplateFor(rec) : null;
  const now = deps.clock.now();
  deps.store.put("mi_policies", rec.loan_id, { policy_id: rec.policy_id, status: rec.status, premium_plan: rec.premium_plan, state: rec.state, consummation: rec.consummation, hpa_covered: rec.hpa_covered, boarded_at: rec.boarded_at,
    last_annual_disclosure_on: rec.last_annual_disclosure_on, next_annual_disclosure_due: plan?.next_due ?? null, annual_disclosure: annual, disclosure_template: template, mi_activated_at: now }, actorOf(deps), now);
  return deps.events.append({ type: "mi_policy.activated", loanId: rec.loan_id, actor: actorOf(deps), payload: {
    policy_id: rec.policy_id, premium_plan: rec.premium_plan, status: rec.status, state: rec.state, hpa_covered: rec.hpa_covered, consummation: rec.consummation, boarded_at: rec.boarded_at,
    last_annual_disclosure_on: rec.last_annual_disclosure_on, annual_disclosure: annual, disclosure_anchor_on: anchor, next_annual_disclosure_due: plan?.next_due ?? null, template,
    lpmi_equivalent_termination_date: rec.lpmi_equivalent_termination_date } });
}

const armed = (deps: DisclosureDeps, code: string, loanId: string): TimerInstance[] => deps.timers.byCode(code).filter((t) => t.loanId === loanId && (t.status === "armed" || t.status === "breached"));
const policyOf = (deps: DisclosureDeps, loanId: string): Record<string, unknown> | undefined => deps.store.get("mi_policies", loanId)?.data;
const recipientsOf = (deps: DisclosureDeps, loanId: string): readonly Recipient[] => (deps.store.get("loan_contacts", loanId)?.data.recipients as readonly Recipient[] | undefined) ?? [];
/** The last approved merge data for the loan (what the scheduler composes from when the agent is off). */
const mergeFieldsOf = (deps: DisclosureDeps, loanId: string): Record<string, unknown> => ({ ...((deps.store.get("mi_disclosure_merge", loanId)?.data as Record<string, unknown> | undefined) ?? {}) });

export interface ComposeInput {
  readonly loan_id: string;
  readonly recipients?: readonly Recipient[];
  readonly payload?: Record<string, unknown>;
  readonly template_code?: string;
  readonly included_with?: "escrow_statement" | "form_1098" | "standalone";
  readonly send_on?: PlainDate;
  readonly escrow_statement_on?: PlainDate | null;
  readonly form_1098_on?: PlainDate | null;
  readonly schedule_version_id?: string | null;
  readonly projected_80_date?: PlainDate | null;
  readonly projected_78_date?: PlainDate | null;
  readonly projected_midpoint_date?: PlainDate | null;
}
export interface ComposeResult {
  readonly status: "composed" | "held";
  readonly disclosure_id: string | null;
  readonly notice_id: string;
  readonly template: DisclosureCode;
  readonly kind: string;
  readonly included_with: "escrow_statement" | "form_1098" | "standalone";
  readonly send_on: PlainDate;
  readonly due_on: PlainDate | null;
  readonly held_reason: string | null;
  readonly rendered: Notice["rendered"];
}

/** `scheduled` → `composed`: carrier, template, checklist, `mi_disclosures` row, `mi.disclosure.composed`. */
export function composeDisclosure(deps: DisclosureDeps, i: ComposeInput): ComposeResult {
  if (!i.loan_id) throw new RangeError("loan_id is required");
  const svc = deps.notices; if (!svc) throw new RangeError("the Notice Registry service is not wired");
  const policy = policyOf(deps, i.loan_id);
  const plan = String(policy?.premium_plan ?? i.payload?.premium_plan ?? "bpmi_monthly");
  if (plan === "lpmi") throw new RangeError("lender-paid MI gets no annual disclosure (12 U.S.C. 4905(b)); the 4905(c)(2) options notice is process 10.2");
  const template = (i.template_code as DisclosureCode | undefined) ?? (policy?.disclosure_template as DisclosureCode | null | undefined)
    ?? disclosureTemplateFor({ premium_plan: plan, consummation: policy?.consummation ? D(String(policy.consummation)) : null, hpa_covered: policy?.hpa_covered !== false, state: policy?.state ? String(policy.state) : null });
  if (!template || !DISCLOSURE_CODES.has(template)) throw new RangeError(`${String(template)} is not an annual PMI disclosure template`);
  const today = todayOf(deps);
  const lastSent = policy?.last_annual_disclosure_on ? D(String(policy.last_annual_disclosure_on)) : null;
  const boardedOn = policy?.boarded_at ? D(String(policy.boarded_at)) : today;
  // R2 — carrier: the escrow statement when it falls in [next_due − 120, next_due], else the 1098, else standalone at next_due − 15.
  const carrier = disclosurePlan({ last_sent: lastSent, boarded_on: boardedOn, escrow_statement_on: i.escrow_statement_on ?? null, form_1098_on: i.form_1098_on ?? null });
  const included_with = i.included_with ?? (i.escrow_statement_on !== undefined || i.form_1098_on !== undefined ? carrier.included_with : "standalone");
  const send_on = i.send_on ?? (i.included_with === undefined && (i.escrow_statement_on !== undefined || i.form_1098_on !== undefined) ? carrier.send_on : today);
  const due_on = policy?.next_annual_disclosure_due ? D(String(policy.next_annual_disclosure_due)) : (policy ? carrier.next_due : null);
  const payload: Record<string, unknown> = { ...mergeFieldsOf(deps, i.loan_id), ...(i.payload ?? {}) };
  for (const k of ["projected_80_date", "projected_78_date", "projected_midpoint_date"] as const) if (i[k] !== undefined && i[k] !== null) payload[k] = i[k];
  const missingDates = (["projected_80_date", "projected_78_date", "projected_midpoint_date"] as const).filter((k) => payload[k] === undefined || payload[k] === null);
  if (missingDates.length) {
    // Guardrail: a loan lacking a schedule version or original value gets the disclosure with "contact us" text plus an internal exception — never skipped.
    payload.projected_dates_unavailable = true; payload.contact_us_for_dates = "Contact us at the address or telephone number below to learn the dates on which your mortgage insurance may be cancelled or will terminate.";
    deps.escalations?.open({ kind: "human_agent", loanId: i.loan_id, payload: { exception: "MI_DISCLOSURE_PROJECTION_UNAVAILABLE", missing: missingDates, template, guardrail: "10.4: dates replaced by contact-us text; disclosure never skipped" } }, actorOf(deps));
  }
  if (i.schedule_version_id) payload.schedule_version_id = i.schedule_version_id;
  const scheduleVersion = i.schedule_version_id ?? (typeof payload.schedule_version_id === "string" ? payload.schedule_version_id : null);   // the merge data's version after `mi.schedule.updated`
  const recipients = i.recipients ?? recipientsOf(deps, i.loan_id);
  const n = svc.render({ templateCode: template, loanId: i.loan_id, recipients, payload, asOf: send_on });
  const kind = DISCLOSURE_KIND[template];
  const now = deps.clock.now();
  const base = { status: n.status, disclosure_id: null, notice_id: n.id, template, kind, included_with, send_on, due_on, rendered: n.rendered } as const;
  if (n.status === "held") {
    deps.events.append({ type: "mi.disclosure.held", loanId: i.loan_id, actor: actorOf(deps), payload: { notice_id: n.id, template, reason: n.heldReason ?? "held", included_with, send_on } });
    return { ...base, status: "held", held_reason: n.heldReason ?? "held" };
  }
  const id = `mid-${i.loan_id}-${n.id.slice(0, 8)}`;
  deps.store.put("mi_disclosures", id, { loan_id: i.loan_id, mi_policy_id: policy?.policy_id ?? null, kind, due_on, notice_id: n.id, template, channel: null, included_with, send_on,
    projected_80_date: payload.projected_80_date ?? null, projected_78_date: payload.projected_78_date ?? null, projected_midpoint_date: payload.projected_midpoint_date ?? null,
    schedule_version_id: scheduleVersion, sent_at: null, status: "composed", composed_at: now }, actorOf(deps), now);
  deps.store.put("mi_disclosure_merge", i.loan_id, { ...payload }, actorOf(deps), now);   // the last approved merge data (AI-off scheduler input)
  deps.events.append({ type: "mi.disclosure.composed", loanId: i.loan_id, actor: actorOf(deps), payload: { disclosure_id: id, notice_id: n.id, template, kind, included_with, send_on, due_on, schedule_version_id: scheduleVersion,
    projected_80_date: payload.projected_80_date ?? null, projected_78_date: payload.projected_78_date ?? null, projected_midpoint_date: payload.projected_midpoint_date ?? null } });
  return { ...base, status: "composed", disclosure_id: id, held_reason: null };
}

export interface ReleaseResult {
  readonly status: "sent" | "suppressed" | "held";
  readonly disclosure_id: string;
  readonly notice_id: string;
  readonly template: string;
  readonly included_with: string;
  readonly channel: string | null;
  readonly sent_on: PlainDate | null;
  readonly next_annual_disclosure_due: PlainDate | null;
  readonly suppress_pmi_page: boolean;
  readonly send_instead: { code: "NTC_HPA_4904A_CANCELLED"; due: PlainDate } | null;
  readonly held_reason: string | null;
  readonly rendered: Notice["rendered"];
}

/** `composed` → `sent`: re-check MI status at release, send through the registry, record evidence, re-anchor the cycle. */
export async function releaseDisclosure(deps: DisclosureDeps, i: { disclosure_id: string; channel_context?: Record<string, unknown> }): Promise<ReleaseResult> {
  if (!i.disclosure_id) throw new RangeError("disclosure_id is required");
  const svc = deps.notices; if (!svc) throw new RangeError("the Notice Registry service is not wired");
  const row = deps.store.require("mi_disclosures", i.disclosure_id).data;
  const loanId = String(row.loan_id); const noticeId = String(row.notice_id); const template = String(row.template); const included_with = String(row.included_with);
  const today = todayOf(deps); const now = deps.clock.now(); const n0 = svc.get(noticeId);
  const policy = policyOf(deps, loanId);
  const terminatedOn = policy?.terminated_on ? D(String(policy.terminated_on)) : null;
  const check = disclosureReleaseCheck({ terminated_on: terminatedOn, release_on: today });
  const base = { disclosure_id: i.disclosure_id, notice_id: noticeId, template, included_with, rendered: n0.rendered } as const;
  if (check.suppress_pmi_page) {
    deps.store.put("mi_disclosures", i.disclosure_id, { status: "suppressed", suppressed_at: now }, actorOf(deps), now);
    deps.events.append({ type: "mi.disclosure.suppressed", loanId, actor: actorOf(deps), payload: { disclosure_id: i.disclosure_id, notice_id: noticeId, template, terminated_on: terminatedOn, send_instead: check.send_instead } });
    return { ...base, status: "suppressed", channel: null, sent_on: null, next_annual_disclosure_due: null, suppress_pmi_page: true, send_instead: check.send_instead, held_reason: null };
  }
  const n = await svc.send(noticeId, i.channel_context ?? {});   // NoticeHeld for a checklist-held notice: a failed checklist blocks release
  if (n.status !== "sent") return { ...base, status: "held", channel: null, sent_on: null, next_annual_disclosure_due: null, suppress_pmi_page: false, send_instead: null, held_reason: n.heldReason ?? "held" };
  const channel = n.channelDecision?.find((d) => !d.held)?.channel ?? null;
  const next = disclosurePlan({ last_sent: today, boarded_on: today, escrow_statement_on: null, form_1098_on: null }).next_due;
  deps.store.put("mi_disclosures", i.disclosure_id, { status: "sent", sent_at: now, sent_on: today, channel }, actorOf(deps), now);
  if (policy) deps.store.put("mi_policies", loanId, { last_annual_disclosure_on: today, next_annual_disclosure_due: next }, actorOf(deps), now);
  deps.events.append({ type: "mi.disclosure.sent", loanId, actor: actorOf(deps), payload: { disclosure_id: i.disclosure_id, notice_id: noticeId, template, kind: row.kind, included_with, channel, sent_on: today, next_annual_disclosure_due: next,
    projected_78_date: row.projected_78_date ?? null, schedule_version_id: row.schedule_version_id ?? null } });
  return { ...base, status: "sent", channel, sent_on: today, next_annual_disclosure_due: next, suppress_pmi_page: false, send_instead: null, held_reason: null, rendered: n.rendered };
}

/** Compose and release in one step (the standalone / auto-send path). */
export async function composeAndReleaseDisclosure(deps: DisclosureDeps, i: ComposeInput & { channel_context?: Record<string, unknown> }): Promise<ComposeResult | ReleaseResult> {
  const c = composeDisclosure(deps, i);
  if (c.status !== "composed" || !c.disclosure_id) return c;
  return releaseDisclosure(deps, { disclosure_id: c.disclosure_id, ...(i.channel_context ? { channel_context: i.channel_context } : {}) });
}

export interface BreachHandled { readonly code: string; readonly timer_id: string; readonly loan_id: string; readonly escalation_id: string | null; readonly sentinel_line: string; readonly notice_id: string | null; readonly auto_sent: boolean; readonly held_reason: string | null; }

/** Breach of the 12-month clock: auto-send the standalone disclosure, open `officer` sev-2 with the Sentinel line (10.4-T2). */
export async function handleAnnualDisclosureBreach(deps: DisclosureDeps, b: Breach): Promise<BreachHandled> {
  if (b.def.code !== HPA_ANNUAL && b.def.code !== MN_ANNUAL) throw new RangeError(`${b.def.code} is not a 10.4 annual disclosure clock`);
  const loanId = b.instance.loanId ?? b.instance.subject.id;
  const due = b.instance.dueDate ?? b.instance.anchorDate;
  let notice: string | null = null, sent = false, held: string | null = null;
  try {
    const r = await composeAndReleaseDisclosure(deps, { loan_id: loanId, included_with: "standalone", payload: { notice_date: todayOf(deps) } });
    notice = r.notice_id; sent = r.status === "sent"; held = r.held_reason;
  } catch (e) { held = (e as Error).message; }
  const line = `${b.def.code} breached: annual PMI disclosure due ${due} 23:59 (anchor ${b.instance.anchorDate}) not sent; standalone disclosure ${sent ? `auto-sent (notice ${notice})` : `NOT sent (${held})`} (loan ${loanId})`;
  const esc = deps.escalations?.open({ kind: "officer", ownerRole: b.escalateTo[0] ?? "officer", loanId, severity: `sev${b.severity ?? 2}`, slaTimerId: b.instance.id,
    payload: { timer_id: b.instance.id, code: b.def.code, due_date: due, breach: b.breachText, sentinel_line: line, report: "Compliance Sentinel daily report", auto_sent: sent, notice_id: notice, held_reason: held } }, actorOf(deps)) ?? null;
  return { code: b.def.code, timer_id: b.instance.id, loan_id: loanId, escalation_id: esc?.id ?? null, sentinel_line: line, notice_id: notice, auto_sent: sent, held_reason: held };
}

export interface SweepResult {
  readonly activated: readonly string[];
  readonly approaching: readonly { loan_id: string; timer_id: string; elapsed_pct: number; disclosure_due_on: PlainDate; compose_by: PlainDate }[];
  readonly breaches: readonly BreachHandled[];
}

/** The daily scheduler: activate policies on file, breach handling, and the 70%-elapsed compose lead. */
export async function runDisclosureSweep(deps: DisclosureDeps, nowIso: string = deps.clock.now()): Promise<SweepResult> {
  const today = wallClock(Date.parse(nowIso), "America/New_York").date;
  const activated: string[] = [];
  for (const row of deps.store.list("mi_policies", (d) => d.status === "active" && BPMI_PLANS_10_4.has(String(d.premium_plan)) && !d.mi_activated_at)) {
    try { if (activateMiPolicy(deps, validateMiPolicyRecord(row.id, { ...row.data, policy_id: row.data.policy_id ?? `mi-${row.id}` }))) activated.push(row.id); } catch { /* an incomplete boarding row is the boarding exception's problem (W-006), not the scheduler's */ }
  }
  const breaches: BreachHandled[] = [];
  for (const b of deps.timers.evaluate(nowIso)) if (b.def.code === HPA_ANNUAL || b.def.code === MN_ANNUAL) breaches.push(await handleAnnualDisclosureBreach(deps, b));
  const approaching: { loan_id: string; timer_id: string; elapsed_pct: number; disclosure_due_on: PlainDate; compose_by: PlainDate }[] = [];
  const already = new Set(deps.events.ofType("mi.disclosure.due_approaching").map((e) => String(e.payload.timer_id)));
  for (const t of deps.timers.byCode(HPA_ANNUAL)) {
    if (t.status !== "armed" || !t.dueDate || !t.loanId || already.has(t.id)) continue;
    const total = daysBetween(t.anchorDate, t.dueDate); if (total <= 0) continue;
    const elapsed_pct = Math.floor((daysBetween(t.anchorDate, today) * 100) / total);
    if (elapsed_pct < 70) continue;
    const compose_by = addDays(t.dueDate, -30);
    deps.events.append({ type: "mi.disclosure.due_approaching", loanId: t.loanId, actor: actorOf(deps), payload: { timer_id: t.id, code: HPA_ANNUAL, elapsed_pct, disclosure_due_on: t.dueDate, disclosure_anchor_on: t.anchorDate, compose_by } });
    approaching.push({ loan_id: t.loanId, timer_id: t.id, elapsed_pct, disclosure_due_on: t.dueDate, compose_by });
  }
  return { activated, approaching, breaches };
}

/** Ingestion subscriptions; returns the detach function. */
export function attachDisclosureHooks_10_4(deps: DisclosureDeps): () => void {
  const offBoarded = deps.events.subscribe("loan.boarded", (e) => {
    if (!e.loanId) return;
    const mi = e.payload.mi;
    const raw = mi !== null && typeof mi === "object" ? { ...(mi as Record<string, unknown>) } : policyOf(deps, e.loanId);
    if (!raw || (raw.status ?? "active") !== "active") return;   // §1.1's event alone carries no MI fields; nothing to activate
    if (raw.boarded_at === undefined || raw.boarded_at === null) raw.boarded_at = e.payload.boarded_at ?? e.occurredAt;
    activateMiPolicy(deps, validateMiPolicyRecord(e.loanId, raw));
  });
  const offStatement = deps.events.subscribe("escrow.statement.sent", (e) => {
    if (!e.loanId) return;
    const state = String(policyOf(deps, e.loanId)?.state ?? "");
    if (state === "CA") return;   // the CA-variant PMI notice must ride this statement (Cal. Civ. Code §2954.6); the registry clock stays armed
    for (const t of armed(deps, CA_STATEMENT, e.loanId)) deps.timers.cancel(t.id, `jurisdiction override (CA): property state ${state || "unknown"} — Cal. Civ. Code §2954.6 does not apply`, actorOf(deps));
  });
  const offEnded = deps.events.subscribe("mi.*", (e) => {
    if (!e.loanId || !["mi.terminated", "mi.cancelled", "mi.rescinded"].includes(e.type)) return;
    const effective = optDate(e.payload.effective_on ?? e.payload.effective, "effective") ?? wallClock(Date.parse(e.occurredAt), "America/New_York").date;
    deps.store.put("mi_policies", e.loanId, { status: e.type === "mi.terminated" ? "terminated" : e.type === "mi.cancelled" ? "cancelled" : "rescinded", terminated_on: effective, annual_disclosure: false }, actorOf(deps), deps.clock.now());
    for (const code of [HPA_ANNUAL, MN_ANNUAL, COMPOSE_LEAD, FIRST_60]) for (const t of armed(deps, code, e.loanId)) deps.timers.cancel(t.id, `${e.type} effective ${effective}: no annual disclosure after MI ends (10.4 inputs)`, actorOf(deps));
  });
  // "`mi.schedule.updated` → refresh the projected dates shown on the next disclosure (no resend)": the merge data for the
  // next composition takes the new schedule version's dates; the prior `mi_disclosures` row keeps its projection (10.4-T9).
  const offSchedule = deps.events.subscribe("mi.schedule.updated", (e) => {
    if (!e.loanId) return;
    const fresh: Record<string, unknown> = {};
    for (const k of ["projected_80_date", "projected_78_date", "projected_midpoint_date", "schedule_version_id"]) if (e.payload[k] !== undefined) fresh[k] = e.payload[k];
    if (Object.keys(fresh).length) deps.store.put("mi_disclosure_merge", e.loanId, fresh, actorOf(deps), deps.clock.now());
  });
  return () => { offBoarded(); offStatement(); offEnded(); offSchedule(); };
}
