/**
 * 32.14 S0–S2 — the L0 lead over the same-origin proxy (`/app/api/v1/borrower/lead`, DELTA-11).
 *
 * The lead is anonymous: no session, no party. The proxy keeps the opaque lead token in the
 * HttpOnly `sm_borrower_lead` cookie and forwards it as `x-borrower-lead`; the browser never
 * sees it, so no response type here carries `lead_token`. Money is a decimal string of cents
 * (`Cents`) and rates/APRs are decimal strings in percent units (`Rate`) — never numbers.
 *
 * `request()` in ./client.ts is module-private, so this file carries its own minimal POST over
 * `apiBase()`; failures are the same `ApiRequestError` the shell already handles
 * (`{code, copy_key}` → `copy(copy_key)`).
 */
import type { Cents, Rate } from "@/lib/types/cards";
import type { ApiError } from "@/lib/types/record";
import { apiBase, ApiRequestError } from "./client";

export const LEAD_PATH = "/v1/borrower/lead";

/** The three goal tiles, one-to-one onto `transaction_type` (§1 principle 6). */
export type LeadGoal = "buy" | "lower_rate" | "cash_out";
export type LeadContract = "signed" | "looking";
export type LeadOccupancy = "primary" | "second_home" | "investment";
/** Fixed step order: goal → (buy: contract · refi/cash-out: occupancy) → state → estimate → identify (S1/S2). */
export type LeadStepId = "goal" | "contract" | "occupancy" | "state" | "estimate" | "identify";

/** A thread line authored by the API as a copy key (never prose the client interprets). */
export type LeadLine = {
  message_id: string;
  at: string;
  sender: "agent" | "system" | "notice";
  sender_label?: string;
  automation_marker?: boolean;
  copy_key: string;
  copy_tokens?: Record<string, string>;
  /** An optional state variant (UT/CA re-delivery of the disclosure, S1 (ii)). */
  state_variant?: string | null;
};

export type LeadStepOption = { id: string; copy_key?: string };
export type LeadStepField = { id?: string; path?: string; copy_key?: string; kind?: string };

export type LeadStep = {
  id: LeadStepId;
  kind: "ChoiceCard" | "ConfirmCard" | "StatusCard";
  copy_key: string;
  options?: LeadStepOption[];
  /** The estimate step names its fields as the API sends them: `{id, copy_key, kind}` objects (a bare id string is tolerated). Purchase → price_range_cents + down_payment_cents; refinance / cash-out → value_estimate_cents + stated_existing_balance_cents. */
  fields?: (string | LeadStepField)[];
  /** A cash-out estimate carries the program cap as a plain limit (never a decline). */
  limit?: { max_ltv_pct?: string } | null;
  transaction_intent?: "purchase" | "limited_cash_out" | "cash_out" | null;
  goal?: LeadGoal | null;
};

export type LeadClosed = { reason: string; copy_key: string; state?: string };

export type LeadPartner = { legal_name: string; nmlsr_id?: string };

/** 20.3 rule 7: the sheet's published low–high for the product, with APR beside each rate, already rendered and checked (20.2). */
export type LeadRange = {
  low_pct: Rate;
  high_pct: Rate;
  apr_low_pct: Rate;
  apr_high_pct: Rate;
  product_code: string;
  rate_sheet_id: string;
  text: string;
};

export type LeadStateResponse = {
  lead_id: string;
  partner?: LeadPartner;
  lines: LeadLine[];
  step: LeadStep | null;
  closed?: LeadClosed | null;
  range?: LeadRange | null;
};
export type LeadStartResponse = LeadStateResponse;

export type LeadAnswerResponse = {
  lead_id: string;
  lines: LeadLine[];
  step: LeadStep | null;
  closed?: LeadClosed | null;
};

/** Refinance / cash-out: own-stated value and existing balance (rule 6 facts). Purchase: price range and down payment. */
export type LeadEstimate = { value_estimate_cents: Cents; stated_existing_balance_cents: Cents } | { price_range_cents: Cents; down_payment_cents: Cents };

export type LeadAnswerValue = LeadGoal | LeadContract | LeadOccupancy | string | LeadEstimate;

export type LeadRangeResponse = {
  range: LeadRange | null;
  /** `RANGE_CONTENT_CHECK` when the 20.2 checklist failed: no number, the identity ask still renders. */
  refused?: string;
  card?: { kind: "StatusCard"; copy_key: string; personal_terms: false };
  promise_copy_key?: string;
  disclaimer_copy_key?: string;
  next: LeadStep | null;
};

export type LeadStartInput = { referral?: string; utm?: Record<string, string> };

async function post<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${apiBase()}${LEAD_PATH}`, {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let err: ApiError = { code: `http_${res.status}`, copy_key: "error.generic" };
    try {
      err = (await res.json()) as ApiError;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiRequestError(res.status, err);
  }
  return (await res.json()) as T;
}

/** S0: `lead.start` as borrower-app (global scope, party_id null) + the disclosure acknowledged on render. A live lead cookie answers that lead's state instead. */
export function leadStart(input: LeadStartInput = {}): Promise<LeadStartResponse> {
  return post<LeadStartResponse>({ action: "start", channel: "web_chat", ...(input.referral ? { referral: input.referral } : {}), ...(input.utm && Object.keys(input.utm).length ? { utm: input.utm } : {}) });
}

/** A reload of the lead behind the cookie; 404 `LEAD_UNKNOWN` when the cookie is stale. */
export function leadState(): Promise<LeadStateResponse> {
  return post<LeadStateResponse>({ action: "state" });
}

/** S1: one chip → 32.14 `lead.answer` → 20.3 `explainProgram{op=set_fact}`; refusals 409 `{code, copy_key}` (L0_FACTS_ONLY, STATE_GATE_FIRST, STEP_ORDER, LEAD_CLOSED). */
export function leadAnswer(step: LeadStepId, value: LeadAnswerValue): Promise<LeadAnswerResponse> {
  return post<LeadAnswerResponse>({ action: "answer", step, value });
}

/** S2: 32.14 `lead.requestRange` → the published range through the 20.2 checklist, or `{range: null, refused}`. */
export function leadRange(): Promise<LeadRangeResponse> {
  return post<LeadRangeResponse>({ action: "range" });
}

/** `?ref=` and `utm_*` from the landing URL (S0 trigger) — passed through to `lead.start`, never stored in the browser. */
export function referralFromSearch(search: string): LeadStartInput {
  const params = new URLSearchParams(search);
  const out: LeadStartInput = {};
  const ref = params.get("ref");
  if (ref) out.referral = ref;
  const utm: Record<string, string> = {};
  for (const [k, v] of params) if (k.startsWith("utm_") && v) utm[k.slice(4)] = v;
  if (Object.keys(utm).length) out.utm = utm;
  return out;
}
