"use client";

/**
 * 32.14 S0–S2 — the anonymous minute: the root of the borrower host renders the thread before any
 * session (docs/ux/15 §1 principles 1–4, 6, 7). Everything here lives on the 20.3 lead behind the
 * proxy's HttpOnly lead cookie (DELTA-11); the browser holds no answer as the source of anything —
 * each response's lines and next step are rendered as they come back.
 *
 *  S0  mount → `lead.start` (a live lead cookie answers that lead's state instead); the disclosure
 *      line renders FIRST with the automation marker; then the headline, the goal tiles (the real
 *      ChoiceCard — same look, same copy options) and the quiet time-budget line.
 *  S1  goal → (buy: contract · refi/cash-out: occupancy) chips, nothing preselected; the state as a
 *      `select` (50 + DC); the estimate as two money fields that produce cents strings with no float
 *      arithmetic. A closed state renders `lead.state_closed` and nothing else.
 *  S2  `lead.requestRange` → StatusCard `entry.range.card` (APR beside each rate, formatRate on the
 *      sheet's strings), the `entry.range.disclaimer` footer, the `entry.range.promise` line, then the
 *      identity ask through `renderIdentity` (the shell's SignIn plugs in there; S3 is not built here).
 *      `RANGE_CONTENT_CHECK` → no number, the identity ask still renders.
 *
 * Every rendered sentence is a copy key; errors render the refusal's `copy_key` or `error.generic`.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CardInstance, Cents } from "@/lib/types/cards";
import { ApiRequestError } from "@/lib/api/client";
import {
  leadAnswer,
  leadRange,
  leadStart,
  referralFromSearch,
  type LeadAnswerResponse,
  type LeadClosed,
  type LeadEstimate,
  type LeadGoal,
  type LeadLine,
  type LeadPartner,
  type LeadRange,
  type LeadRangeResponse,
  type LeadStateResponse,
  type LeadStep,
  type LeadStepId,
} from "@/lib/api/lead";
import { isCopyKey, copy, copyExtra, copyOptions, type Tokens } from "@/lib/copy";
import { formatDate, formatMoney, formatRate } from "@/lib/format";
import { ChoiceCard } from "@/components/cards/ChoiceCard";
import { StatusCard } from "@/components/cards/StatusCard";
import { CardFrame, nowIso } from "@/components/cards/CardFrame";
import { parseMoneyToCents } from "./money";
import { US_STATES, stateName } from "./states";

export type AnonymousMinuteProps = {
  /** S3's identity ask, rendered after the range (or after the refused range). The shell supplies its SignIn here. */
  renderIdentity?: () => ReactNode;
};

type StepEntry = { kind: "step"; step: LeadStep; status: "pending" | "resolved"; chosen?: string; receipt?: string; created_at: string; resolved_at?: string };
type Entry = { kind: "line"; line: LeadLine } | StepEntry | { kind: "range"; res: LeadRangeResponse; created_at: string } | { kind: "identity"; step: LeadStep };

/** The chips' option ids when the API names only the step (the copy library holds the labels, in the same order). */
const DEFAULT_OPTIONS: Partial<Record<LeadStepId, string[]>> = {
  goal: ["buy", "lower_rate", "cash_out"],
  contract: ["signed", "looking"],
  occupancy: ["primary", "second_home", "investment"],
};

/** Option labels come from the step's copy key; the library's original entry-flow keys are the fallback, never a literal. */
const LABEL_FALLBACK_KEY: Partial<Record<LeadStepId, string>> = { goal: "entry.goal.question", contract: "entry.goal.contract", occupancy: "entry.occupancy" };

const PRODUCT_LABEL_INDEX: Record<string, number> = { FRM30: 0, FRM15: 1, ARM: 2 };

/** "FRM30" → the library's product label (`product.choice` options: 30-year fixed · 15-year fixed · Adjustable (ARM)). */
export function productLabel(product_code: string): string {
  const idx = PRODUCT_LABEL_INDEX[product_code] ?? (product_code.startsWith("ARM") ? 2 : undefined);
  const labels = copyOptions("product.choice");
  return idx !== undefined && labels[idx] ? labels[idx] : product_code;
}

/** A rate string through formatRate; a malformed string stays visible as sent (never a number). */
function safeRate(rate: string): string {
  try {
    return formatRate(rate);
  } catch {
    return rate;
  }
}

function errorText(e: unknown): string {
  return e instanceof ApiRequestError ? copy(e.body.copy_key) : copy("error.generic");
}

function partnerTokens(partner: LeadPartner | undefined): Tokens {
  if (!partner) return {};
  return { "partner.legal_name": partner.legal_name, ...(partner.nmlsr_id ? { "partner.nmlsr_id": partner.nmlsr_id } : {}) };
}

function optionLabels(step: LeadStep): readonly string[] {
  const own = copyOptions(step.copy_key);
  if (own.length) return own;
  const fb = LABEL_FALLBACK_KEY[step.id];
  return fb ? copyOptions(fb) : [];
}

function choiceInstance(e: StepEntry, leadId: string): CardInstance<"ChoiceCard"> {
  const ids = e.step.options?.map((o) => o.id) ?? DEFAULT_OPTIONS[e.step.id] ?? [];
  const labels = optionLabels(e.step);
  const options = ids.map((id, i) => {
    const o = e.step.options?.[i];
    const label = o?.copy_key ? copy(o.copy_key) : (labels[i] ?? id);
    return { id, label };
  });
  return {
    card_instance_id: `lead-${e.step.id}`,
    conversation_id: `lead:${leadId}`,
    party_id: "",
    subject: {},
    kind: "ChoiceCard",
    status: e.status,
    created_by: "agent:intake",
    copy_key: e.step.copy_key,
    created_at: e.created_at,
    resolved_at: e.resolved_at,
    evidence: e.chosen ? { option_id: e.chosen } : undefined,
    props: { options, command: "lead.answer", command_args_by_option: Object.fromEntries(ids.map((id) => [id, { step: e.step.id, value: id }])) },
  };
}

/** The estimate's two fields: purchase (price range · down payment) or refinance/cash-out (value · balance). */
const ESTIMATE_COPY: Readonly<Record<string, string>> = { price_range_cents: "entry.estimate.price_range", down_payment_cents: "entry.estimate.down_payment", value_estimate_cents: "entry.estimate.value", stated_existing_balance_cents: "entry.estimate.balance" };
/** The wire's field ids (objects `{id, copy_key}` as the API sends them, or bare strings). */
function fieldIds(step: LeadStep): { id: string; copy_key?: string }[] {
  return (step.fields ?? []).map((f) => (typeof f === "string" ? { id: f } : { id: String(f.id ?? f.path ?? ""), ...(f.copy_key ? { copy_key: f.copy_key } : {}) })).filter((f) => f.id in ESTIMATE_COPY);
}
function estimateFields(step: LeadStep, goal: LeadGoal | undefined): { path: string; copy_key: string }[] {
  const wire = fieldIds(step);
  // the API's own field list wins (it is the lead's transaction type); the goal tile is the fallback for a step that names none
  if (wire.length) return wire.map((f) => ({ path: f.id, copy_key: f.copy_key ?? ESTIMATE_COPY[f.id]! }));
  const purchase = step.transaction_intent === "purchase" || step.goal === "buy" || (!step.transaction_intent && !step.goal && goal === "buy");
  return purchase
    ? [
        { path: "price_range_cents", copy_key: "entry.estimate.price_range" },
        { path: "down_payment_cents", copy_key: "entry.estimate.down_payment" },
      ]
    : [
        { path: "value_estimate_cents", copy_key: "entry.estimate.value" },
        { path: "stated_existing_balance_cents", copy_key: "entry.estimate.balance" },
      ];
}

const ENTRY_CSS = `
.sm-entry-headline { font-size: var(--sm-fs-28); font-weight: 700; letter-spacing: -0.01em; line-height: 1.2; margin: 12px 0 4px; max-width: 720px; }
.sm-entry-quiet { display: block; max-width: 720px; margin: 0 0 12px; }
[data-entry-step="goal"] .sm-options { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
.sm-entry-fields { display: grid; gap: 10px; margin: 8px 0; }
`;

export function AnonymousMinute({ renderIdentity }: AnonymousMinuteProps) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const entriesRef = useRef<Entry[]>([]);
  const [leadId, setLeadId] = useState("");
  const [partner, setPartner] = useState<LeadPartner | undefined>();
  const [goal, setGoal] = useState<LeadGoal | undefined>();
  const [closed, setClosed] = useState<LeadClosed | undefined>();
  const [knownState, setKnownState] = useState<string | undefined>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const startedRef = useRef(false);
  const mountedRef = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);

  const commit = useCallback((next: Entry[]) => {
    entriesRef.current = next;
    if (mountedRef.current) setEntries(next);
  }, []);

  /** Append a response's lines, then its next step / closed line; returns true when the range should be requested next. */
  const apply = useCallback(
    (res: LeadStateResponse | LeadAnswerResponse): boolean => {
      const next = [...entriesRef.current, ...res.lines.map<Entry>((line) => ({ kind: "line", line }))];
      const range = "range" in res ? res.range : undefined;
      if (res.closed) {
        // S1 (i): the closed-state line, once — from the response's own line when it carries it, else from `closed.copy_key`.
        if (!res.lines.some((l) => l.copy_key === res.closed?.copy_key)) {
          next.push({ kind: "line", line: { message_id: `closed-${res.lead_id}`, at: nowIso(), sender: "agent", copy_key: res.closed.copy_key, ...(res.closed.state ? { state_variant: res.closed.state } : {}) } });
        }
        if (mountedRef.current) setClosed(res.closed);
        commit(next);
        return false;
      }
      if (range) {
        next.push({ kind: "range", res: { range, next: res.step ?? { id: "identify", kind: "ChoiceCard", copy_key: "auth.choose_method" } }, created_at: nowIso() });
        next.push({ kind: "identity", step: res.step ?? { id: "identify", kind: "ChoiceCard", copy_key: "auth.choose_method" } });
        commit(next);
        return false;
      }
      if (res.step) {
        if (res.step.id === "identify") next.push({ kind: "identity", step: res.step });
        else next.push({ kind: "step", step: res.step, status: "pending", created_at: nowIso() });
        commit(next);
        return false;
      }
      commit(next);
      return true;
    },
    [commit],
  );

  const requestRange = useCallback(async () => {
    const res = await leadRange();
    const next: Entry[] = [...entriesRef.current, { kind: "range", res, created_at: nowIso() }];
    if (res.next) next.push({ kind: "identity", step: res.next });
    commit(next);
  }, [commit]);

  useEffect(() => {
    mountedRef.current = true;
    if (!startedRef.current) {
      startedRef.current = true;
      void (async () => {
        try {
          const res = await leadStart(referralFromSearch(typeof window === "undefined" ? "" : window.location.search));
          if (mountedRef.current) {
            setLeadId(res.lead_id);
            if (res.partner) setPartner(res.partner);
            if (res.step?.goal) setGoal(res.step.goal);
          }
          if (apply(res)) await requestRange();
        } catch (e) {
          if (mountedRef.current) setError(errorText(e));
        } finally {
          if (mountedRef.current) setBusy(false);
        }
      })();
    }
    return () => {
      mountedRef.current = false;
    };
  }, [apply, requestRange]);

  useEffect(() => {
    const s = scroller.current;
    if (s) s.scrollTop = s.scrollHeight;
  }, [entries.length]);

  const answer = useCallback(
    async (entry: StepEntry, value: string | LeadEstimate, receipt: string) => {
      setBusy(true);
      setError(undefined);
      try {
        const res = await leadAnswer(entry.step.id, value);
        if (entry.step.id === "goal" && typeof value === "string") setGoal(value as LeadGoal);
        if (entry.step.id === "state" && typeof value === "string") setKnownState(value);
        const chosen = typeof value === "string" ? value : undefined;
        commit(entriesRef.current.map((e) => (e === entry ? { ...e, status: "resolved", chosen, receipt, resolved_at: nowIso() } : e)));
        if (apply(res)) await requestRange();
      } catch (e) {
        if (mountedRef.current) setError(errorText(e));
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [apply, commit, requestRange],
  );

  const pendingStep = [...entries].reverse().find((e): e is StepEntry => e.kind === "step" && e.status === "pending");
  const currentStep = closed ? "closed" : pendingStep ? pendingStep.step.id : entries.some((e) => e.kind === "identity") ? "identify" : undefined;

  return (
    <>
      <div className="sm-thread-top">
        {error ? (
          <p className="sm-error" role="alert" data-testid="entry-error" style={{ margin: 0, padding: "8px 16px" }}>
            {error}
          </p>
        ) : null}
      </div>
      <div ref={scroller} className="sm-thread-scroll" role="log" aria-label="Conversation" aria-busy={busy} data-testid="anonymous-minute" data-step={currentStep} data-closed={closed?.reason} data-lead-id={leadId || undefined}>
        <style href="sm-entry" precedence="default">
          {ENTRY_CSS}
        </style>
        {entries.map((e, i) => {
          switch (e.kind) {
            case "line":
              return <LeadLineView key={`line-${e.line.message_id}-${i}`} line={e.line} partner={partner} state={knownState} timezone={timezone} />;
            case "step":
              return <StepView key={`step-${e.step.id}`} entry={e} leadId={leadId} goal={goal} timezone={timezone} busy={busy} onAnswer={answer} />;
            case "range":
              return <RangeView key="range" res={e.res} partner={partner} timezone={timezone} created_at={e.created_at} />;
            case "identity":
              return (
                <div key="identity" data-testid="identity-ask" data-copy-key={e.step.copy_key}>
                  {renderIdentity?.()}
                </div>
              );
          }
        })}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

const VARIANT_OF_STATE: Readonly<Record<string, string>> = { UT: "ut_high_risk_upfront", CA: "ca_admt_preuse", CO: "co_sb26_189_preuse" };
const STATE_OF_VARIANT: Readonly<Record<string, string>> = { ut_high_risk_upfront: "UT", ca_admt_preuse: "CA", co_sb26_189_preuse: "CO" };
function LeadLineView({ line, partner, state, timezone, testId }: { line: LeadLine; partner?: LeadPartner; /** the state the visitor chose — the `{{state}}` fallback for `lead.state_closed` when the line carries no variant or tokens */ state?: string; timezone: string; testId?: string }) {
  // S1 (ii): the disclosure re-delivered for UT/CA renders that state's own line (`entry.disclosure.<variant>`), never the base sentence twice;
  // the API names the 20.3 variant in `copy_tokens.state_variant` (e.g. ca_admt_preuse); a bare state code on the line is tolerated
  const variantId = line.copy_tokens?.["state_variant"] ?? (line.state_variant ? VARIANT_OF_STATE[line.state_variant] : undefined);
  const variantKey = line.copy_key === "entry.disclosure.first" && variantId && isCopyKey(`entry.disclosure.${variantId}`) ? `entry.disclosure.${variantId}` : null;
  const code = line.state_variant ?? (variantId ? STATE_OF_VARIANT[variantId] : undefined) ?? state;
  const tokens: Tokens = { ...partnerTokens(partner), ...(code ? { state: stateName(code), state_code: code } : {}), ...(line.copy_tokens ?? {}) };
  const text = copy(variantKey ?? line.copy_key, tokens);
  const automated = line.copy_key === "entry.disclosure.first" || line.copy_key === "entry.disclosure.real_person";
  return (
    <div id={`msg-${line.message_id}`} className={`sm-msg${line.sender === "notice" ? " sm-msg-notice" : ""}`} tabIndex={-1} data-sender={line.sender} data-testid={testId ?? "lead-line"} data-copy-key={variantKey ?? line.copy_key} data-state-variant={line.state_variant ?? (variantId ? STATE_OF_VARIANT[variantId] : undefined)}>
      <div className="sm-msg-meta">
        <span data-testid="provenance">{line.sender === "notice" ? "Notice" : (line.sender_label ?? "Supermortgage")}</span>
        {line.automation_marker ? (
          <span className="sm-automation" data-testid="automation-marker" title={partner ? `Automated assistant for ${partner.legal_name}` : undefined}>
            automated
          </span>
        ) : null}
        <time dateTime={line.at}>{formatDate(line.at, timezone, "time")}</time>
      </div>
      <div className="sm-msg-body">
        <span data-copy-key={variantKey ?? line.copy_key} data-automated={automated ? "true" : undefined}>
          {text}
        </span>
      </div>
    </div>
  );
}

function StepView({ entry, leadId, goal, timezone, busy, onAnswer }: { entry: StepEntry; leadId: string; goal?: LeadGoal; timezone: string; busy: boolean; onAnswer: (entry: StepEntry, value: string | LeadEstimate, receipt: string) => Promise<void> }) {
  switch (entry.step.id) {
    case "goal": {
      const inst = choiceInstance(entry, leadId);
      return (
        <div data-entry-step="goal" data-testid="entry-goal">
          <h1 className="sm-entry-headline" data-testid="entry-headline">
            {copy("entry.landing.headline")}
          </h1>
          <ChoiceCard card={inst} timezone={timezone} busy={busy} onResolve={(req) => onAnswer(entry, req.option_id ?? "", inst.props.options.find((o) => o.id === req.option_id)?.label ?? "")} />
          <p className="sm-source sm-entry-quiet" data-testid="entry-time-budget">
            {copy("entry.landing.time_budget")}
          </p>
        </div>
      );
    }
    case "contract":
    case "occupancy": {
      const inst = choiceInstance(entry, leadId);
      return (
        <div data-entry-step={entry.step.id}>
          <ChoiceCard card={inst} timezone={timezone} busy={busy} onResolve={(req) => onAnswer(entry, req.option_id ?? "", inst.props.options.find((o) => o.id === req.option_id)?.label ?? "")} />
        </div>
      );
    }
    case "state":
      return <StateStep entry={entry} leadId={leadId} timezone={timezone} busy={busy} onAnswer={onAnswer} />;
    case "estimate":
      return <EstimateStep entry={entry} leadId={leadId} goal={goal} timezone={timezone} busy={busy} onAnswer={onAnswer} />;
    default:
      return null;
  }
}

/** S1 state: a `select` of the 50 states + DC (the gate runs server-side: 31.1 readiness, UT/CA variant, CO pre-use notice). */
function StateStep({ entry, leadId, timezone, busy, onAnswer }: { entry: StepEntry; leadId: string; timezone: string; busy: boolean; onAnswer: (entry: StepEntry, value: string, receipt: string) => Promise<void> }) {
  const [value, setValue] = useState("");
  const title = copy(entry.step.copy_key);
  const helper = copyExtra(entry.step.copy_key, "helper");
  const inst = choiceInstance(entry, leadId);
  const id = `card-${inst.card_instance_id}`;
  return (
    <div data-entry-step="state">
      <CardFrame card={inst} timezone={timezone} title={title} receipt={`${title} — ${entry.receipt ?? stateName(entry.chosen ?? "")}`} announce={entry.status === "pending" ? undefined : entry.receipt}>
        {helper ? <p>{helper}</p> : null}
        <div className="sm-entry-fields">
          <select id={`${id}-select`} className="sm-select" aria-labelledby={`${id}-title`} value={value} onChange={(e) => setValue(e.target.value)} disabled={busy} data-testid="entry-state-select">
            <option value="">{title}</option>
            {US_STATES.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="sm-card-actions">
          <button type="button" className="sm-btn sm-btn-primary" disabled={busy || !value} onClick={() => void onAnswer(entry, value, stateName(value))} data-testid="entry-state-continue">
            {copy("entry.step.continue")}
          </button>
        </div>
      </CardFrame>
    </div>
  );
}

/** S1 estimate: two typed money fields → decimal strings of cents (parseMoneyToCents, integer-only), posted as one fact. */
function EstimateStep({ entry, leadId, goal, timezone, busy, onAnswer }: { entry: StepEntry; leadId: string; goal?: LeadGoal; timezone: string; busy: boolean; onAnswer: (entry: StepEntry, value: LeadEstimate, receipt: string) => Promise<void> }) {
  const fields = useMemo(() => estimateFields(entry.step, goal), [entry.step, goal]);
  const [text, setText] = useState<Record<string, string>>({});
  // The card's heading: the step's copy unless it is one of the field questions (CardFrame labels the article by its
  // heading, so a heading equal to a field's label would give two elements the same accessible name); else the kind label.
  const title = fields.some((f) => f.copy_key === entry.step.copy_key) ? undefined : copy(entry.step.copy_key);
  const cents = fields.map((f) => parseMoneyToCents(text[f.path] ?? ""));
  const complete = cents.every((c) => c !== null);
  const inst: CardInstance<"ConfirmCard"> = {
    card_instance_id: `lead-${entry.step.id}`,
    conversation_id: `lead:${leadId}`,
    party_id: "",
    subject: {},
    kind: "ConfirmCard",
    status: entry.status,
    created_by: "agent:intake",
    copy_key: entry.step.copy_key,
    created_at: entry.created_at,
    resolved_at: entry.resolved_at,
    props: { fields: [], commits_to: "leads" },
  };
  const submit = () => {
    if (!complete) return;
    const value = Object.fromEntries(fields.map((f, i) => [f.path, cents[i] as Cents])) as unknown as LeadEstimate;
    const receipt = fields.map((_, i) => formatMoney(cents[i] as Cents, { whole: true })).join(" · ");
    void onAnswer(entry, value, receipt);
  };
  const normalize = (path: string) => {
    const c = parseMoneyToCents(text[path] ?? "");
    if (c !== null) setText((t) => ({ ...t, [path]: formatMoney(c, { whole: true }) }));
  };
  return (
    <div data-entry-step="estimate">
      <CardFrame card={inst} timezone={timezone} title={title} receipt={entry.receipt} announce={entry.status === "pending" ? undefined : entry.receipt}>
        <div className="sm-entry-fields">
          {fields.map((f) => {
            const fid = `lead-estimate-${f.path}`;
            const helper = copyExtra(f.copy_key, "helper");
            return (
              <div key={f.path}>
                <label className="sm-label" htmlFor={fid}>
                  {copy(f.copy_key)}
                </label>
                <input id={fid} className="sm-input" inputMode="decimal" autoComplete="off" value={text[f.path] ?? ""} onChange={(e) => setText((t) => ({ ...t, [f.path]: e.target.value }))} onBlur={() => normalize(f.path)} disabled={busy} data-testid={fid} data-path={f.path} />
                {helper ? <span className="sm-source">{helper}</span> : null}
              </div>
            );
          })}
        </div>
        <div className="sm-card-actions">
          <button type="button" className="sm-btn sm-btn-primary" disabled={busy || !complete} onClick={submit} data-testid="entry-estimate-continue">
            {copy("entry.step.continue")}
          </button>
        </div>
      </CardFrame>
    </div>
  );
}

/** S2: the published range as a StatusCard (never a personal figure), the disclaimer footer, the promise line. */
function RangeView({ res, partner, timezone, created_at }: { res: LeadRangeResponse; partner?: LeadPartner; timezone: string; created_at: string }) {
  if (!res.range) {
    return <div data-testid="range-refused" data-refused={res.refused ?? undefined} hidden />;
  }
  const r: LeadRange = res.range;
  const cardKey = res.card?.copy_key ?? "entry.range.card";
  const tokens: Record<string, string> = {
    product: productLabel(r.product_code),
    product_code: r.product_code,
    rate_low: safeRate(r.low_pct),
    rate_high: safeRate(r.high_pct),
    apr_low: safeRate(r.apr_low_pct),
    apr_high: safeRate(r.apr_high_pct),
    ...(partnerTokens(partner) as Record<string, string>),
  };
  const disclaimerKey = res.disclaimer_copy_key ?? "entry.range.disclaimer";
  const disclaimer = copy(disclaimerKey, tokens);
  const serverText = r.text.trim();
  // What 20.2's checklist checked is what is shown: the server's sentence verbatim; the library line (same tokens) only when none was sent.
  const state_label = serverText || copy(cardKey, tokens);
  // The not-a-commitment footer once: from the key unless the checked sentence already carries it.
  const footerIncluded = serverText.includes(disclaimer);
  const inst: CardInstance<"StatusCard"> = {
    card_instance_id: "lead-range",
    conversation_id: "lead",
    party_id: "",
    subject: {},
    kind: "StatusCard",
    status: "resolved",
    created_by: "agent:intake",
    copy_key: cardKey,
    created_at,
    props: { state_label, copy_tokens: tokens, ...(footerIncluded ? {} : { detail_copy_key: disclaimerKey }) },
  };
  const promise: LeadLine = { message_id: "range-promise", at: created_at, sender: "agent", copy_key: res.promise_copy_key ?? "entry.range.promise" };
  return (
    <>
      <div data-testid="range-card" data-personal-terms="false" data-low={r.low_pct} data-high={r.high_pct} data-apr-low={r.apr_low_pct} data-apr-high={r.apr_high_pct} data-product={r.product_code} data-rate-sheet={r.rate_sheet_id}>
        <StatusCard card={inst} timezone={timezone} onResolve={() => {}} />
      </div>
      <LeadLineView line={promise} partner={partner} timezone={timezone} testId="range-promise" />
    </>
  );
}
