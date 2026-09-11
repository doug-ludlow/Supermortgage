/**
 * 32.10 — the Record side of the hardship flow (src/runtime/borrower/record.ts imports this; the flow file imports
 * record.ts, so the projection lives here to keep the module graph acyclic — the same split as 12-exits-record.ts).
 *
 *   hardshipSection(events, byKind)   the Loan section's `hardship` block (02 §1.1 `loan`): the pending application
 *                                     (12.1), the open offer and its acceptance date (12.2), the trial period plan's next
 *                                     payment (12.2 / 12.8), the forbearance term (12.4), a written cease (11.4) and the
 *                                     bankruptcy statement mode (14.3) — every date the owning process's own, never
 *                                     computed here.
 *   FLOW_10_TIMER_ROWS                the 02 §4 labels of the clocks this flow renders beside the 32.2 rows.
 */
export interface HardshipEv { readonly type: string; readonly payload: Record<string, unknown>; readonly occurred_at?: string; readonly sequence?: string }
export interface HardshipEntity { readonly kind: string; readonly id: string; readonly data: Record<string, unknown>; readonly updated_at?: string }
export type ByKind = (kind: string) => readonly HardshipEntity[];
export interface HardshipBlock {
  status: "none" | "application_pending" | "offer_pending" | "tpp_active" | "forbearance" | "plan_accepted" | "deemed_rejected";
  application?: { application_id: string; status: string; received_on?: string; reasonable_date?: string; missing_documents?: string[] };
  offer?: { option?: string; accept_by?: string; status: string; deemed_rejected_on?: string; template?: string; evaluation_id?: string };
  tpp?: { n: number; count: number; amount_cents: string; due_on: string; remaining: number };
  forbearance?: { plan_id: string; term_start: string; term_end: string; status: string; late_charges_suppressed: boolean };
  cease?: { received_on: string; scope: string };
  bankruptcy?: { chapter?: string; statement_mode?: string };
}

/** 32.10 §Timers: the borrower-visible clocks this process renders beside the 32.2 rows — the label is the allow-list's, the date is always `timers.due_at`. */
export const FLOW_10_TIMER_ROWS: readonly { code: string; label: string; calendar: string }[] = [
  { code: "REGX_1024_39A_LIVE_CONTACT_36", label: "We'll try to reach you by", calendar: "calendar days" },
  { code: "REGX_1024_39B_WRITTEN_NOTICE_45", label: "Written options notice to you by", calendar: "calendar days" },
  { code: "REGX_1024_41B2_LM_ACK_5", label: "We confirm what's needed by", calendar: "business days (federal)" },
  { code: "REGX_1024_41C1_EVALUATE_30", label: "Decision by", calendar: "calendar days" },
  { code: "REGX_1024_41H_APPEAL_14", label: "Appeal by", calendar: "calendar days" },
  { code: "REGX_1024_41H_APPEAL_DECISION_30", label: "Appeal decision by", calendar: "calendar days" },
  { code: "FNMA_D23201_FORB_PREEXPIRY_CONTACT_30", label: "We'll talk about what's next by", calendar: "calendar days" },
  { code: "FNMA_D23201_FORB_EXPIRY_DISPOSITION", label: "Forbearance ends", calendar: "calendar days" },
  { code: "REGX_1024_41F1_120_DAY_GATE", label: "No foreclosure referral before", calendar: "calendar days" },
  { code: "SM_FC_REFER_WITHIN_5CD_OF_ELIGIBLE", label: "Referral decision by", calendar: "calendar days" },
];

export const TPP_OFFER_TEMPLATE = "NTC_FNMA_D23206_TPP_OFFER";
const isTrialPayment = (p: Record<string, unknown>): boolean => p["designation"] === "trial" || p["designation"] === "trial_payment";
const latest = <T>(xs: readonly T[]): T | undefined => xs[xs.length - 1];
const s = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export function hardshipSection(events: readonly HardshipEv[], byKind: ByKind): HardshipBlock {
  const of = (type: string, where: (p: Record<string, unknown>) => boolean = () => true) => events.filter((e) => e.type === type && where(e.payload));
  const idx = (e: HardshipEv | undefined): number => (e ? events.indexOf(e) : -1);
  const out: HardshipBlock = { status: "none" };
  // 12.1: the latest application (received → incomplete → complete …); the ack's missing items ride on the row (`changes{missing_documents}`)
  const app = latest(byKind("lossmit_applications").filter((a) => typeof a.data["received_on"] === "string").sort((a, b) => String(a.data["received_on"]).localeCompare(String(b.data["received_on"]))));
  if (app) out.application = { application_id: app.id, status: String(app.data["status"] ?? ""), ...(s(app.data["received_on"]) ? { received_on: String(app.data["received_on"]) } : {}), ...(s(app.data["reasonable_date"]) ? { reasonable_date: String(app.data["reasonable_date"]) } : {}), ...(Array.isArray(app.data["missing_documents"]) ? { missing_documents: (app.data["missing_documents"] as unknown[]).map(String) } : {}) };
  // 12.2: the latest offer sent and what became of it — accepted / rejected (`lossmit.offer.responded`) or deemed rejected after accept_by + the policy grace
  const sent = latest(of("lossmit.offer.sent"));
  if (sent) {
    const evalId = s(sent.payload["evaluation_id"]); const ev = evalId ? byKind("lossmit_evaluations").find((x) => x.id === evalId) : latest(byKind("lossmit_evaluations"));
    const responded = latest(of("lossmit.offer.responded", (p) => !evalId || p["evaluation_id"] === evalId || p["evaluation_id"] === undefined).filter((e) => idx(e) > idx(sent)));
    const deemed = latest(of("lossmit.offer.deemed_rejected", (p) => !evalId || p["evaluation_id"] === evalId || p["evaluation_id"] === undefined).filter((e) => idx(e) > idx(sent)));
    const status = responded ? String(responded.payload["response"]) : deemed ? "deemed_rejected" : "pending";
    out.offer = { ...(s(sent.payload["option"]) ? { option: String(sent.payload["option"]) } : {}), ...(s(ev?.data["accept_by"]) ? { accept_by: String(ev!.data["accept_by"]) } : {}), status, ...(deemed ? { deemed_rejected_on: String(deemed.payload["deemed_rejected_on"] ?? "") } : {}), template: String(sent.payload["template"] ?? ""), ...(evalId ? { evaluation_id: evalId } : {}) };
    // a trial period plan (Flex Mod): the terms the evaluation carries (32.10 DELTA: `lossmit_evaluations.terms`), the payments received so far (cashiering's `payment.received{designation=trial}`)
    const terms = (ev?.data["terms"] as Record<string, unknown> | undefined) ?? {};
    const dueDates = Array.isArray(terms["due_dates"]) ? (terms["due_dates"] as unknown[]).map(String) : [];
    if (String(sent.payload["template"]) === TPP_OFFER_TEMPLATE && dueDates.length) {
      const received = of("payment.received", isTrialPayment).filter((e) => idx(e) > idx(sent)).length;
      const count = Number(terms["trial_count"] ?? dueDates.length); const n = Math.min(received + 1, count);
      out.tpp = { n, count, amount_cents: String(terms["trial_payment_cents"] ?? "0"), due_on: dueDates[n - 1] ?? dueDates[dueDates.length - 1]!, remaining: Math.max(count - received, 0) };
    }
  }
  // 12.4: the forbearance term (activated … ended)
  const activated = latest(of("workout_plan.activated", (p) => p["kind"] === "forbearance"));
  if (activated) {
    const ended = latest(of("workout_plan.ended", (p) => (p["kind"] ?? p["plan_kind"]) === "forbearance").filter((e) => idx(e) > idx(activated)));
    const plan = byKind("workout_plans").find((x) => x.id === String(activated.payload["plan_id"]));
    out.forbearance = { plan_id: String(activated.payload["plan_id"] ?? ""), term_start: String(activated.payload["term_start"] ?? plan?.data["term_start"] ?? ""), term_end: String(activated.payload["term_end"] ?? plan?.data["term_end"] ?? ""), status: ended ? String(ended.payload["status"] ?? "ended") : "active", late_charges_suppressed: plan?.data["late_charges_suppressed"] !== false };
  }
  // 11.4: a written cease (§1006.6(c)) — permanent unless withdrawn in writing
  const cease = latest(of("fdcpa.cease.received", (p) => p["written"] === true));
  if (cease) out.cease = { received_on: String(cease.payload["on"] ?? cease.payload["received_on"] ?? cease.occurred_at?.slice(0, 10) ?? ""), scope: String(cease.payload["scope"] ?? cease.payload["cease_scope"] ?? "written_full") };
  // 14.1 / 14.3: the verified petition and the statement variant in force
  const petition = latest(of("bankruptcy.petition.filed")); const mode = latest(of("bankruptcy.statement_mode.set"));
  if (petition || mode) out.bankruptcy = { ...(s(petition?.payload["chapter"]) ? { chapter: String(petition!.payload["chapter"]) } : {}), ...(s(mode?.payload["mode"]) ? { statement_mode: String(mode!.payload["mode"]) } : {}) };
  // the one-word state the Loan section leads with
  out.status = out.forbearance?.status === "active" ? "forbearance"
    : out.tpp && out.offer?.status === "accepted" ? "tpp_active"
    : out.offer?.status === "accepted" ? "plan_accepted"
    : out.offer?.status === "deemed_rejected" ? "deemed_rejected"
    : out.offer?.status === "pending" ? "offer_pending"
    : out.application && !/closed|withdrawn|denied|exited/.test(out.application.status) && out.application.status !== "complete" && out.application.status !== "facially_complete" ? "application_pending"
    : "none";
  return out;
}
