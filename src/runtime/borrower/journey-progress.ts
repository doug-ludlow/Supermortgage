/**
 * `journey_progress` (docs/ux/17 §2.2 Progress, §5, DELTA-26): the journey's steps — done / current / upcoming, "n of m" —
 * derived by `BorrowerRecordReader` from the event spine and `card_instances`, never stored, never a judgment.
 *
 * The refinance journey is the twelve steps of docs/ux/03 §2 (R1–R12); the purchase journey is 03 §3–§4 (P1–P9, then
 * C1–C7). The common entry E1–E6 (arrive, disclosure, goal, identify, verify identity, consents) is the account and the
 * door (docs/ux/17 §2.0: "account first"): a subject exists only once it is behind the borrower, so it is not a counted
 * step — "E1–R7 done, R8 current" reads "7 of 12" (32.16-T13), the seven being R1–R7.
 *
 * Evidence per step is the owning process's own event, or the borrower's resolved card for the step (a tap, never words —
 * 32.16 §1 principle 6). The journey is ordered, so every step before the furthest step with evidence is done, the first
 * step without evidence is current, and the rest are upcoming; `at` is the step's own evidence time when it has one.
 *
 * Refinance (R1–R12) — the event or card that ends the step:
 *   R1 home            `refi.home.confirm` / `refi.current_loan.confirm` ConfirmCard resolved, or `application.field.captured{property_address}`
 *   R2 credit          `credit.report.received`
 *   R3 income          `income.confirm.title` ConfirmCard resolved, an income ConnectCard connected, `verification.received`, or `application.field.captured{income}`
 *   R4 about you       `profile.title` ProfileCard resolved
 *   R5 declarations    `application.declarations.answered` or the `declarations.title` ChoiceCard resolved
 *   R6 demographics    `application.demographics.collected` or the DemographicsCard resolved
 *   R7 application     `application.trid_received` (the six-item moment)
 *   R8 underwriting    started by `du.submitted` / `du.findings.received`; done on `decision.issued`
 *   R9 terms & LE      started by `mlo.review.completed` / `terms.presented`; done on `disclosure.le.delivered` (or received)
 *   R10 proceed        `intent.to_proceed.received`
 *   R11 lock           `lock.executed`, or the lock ComparisonCard resolved (keep floating is a decision too)
 *   R12 hand-off       `closing.consummated` / `loan.funded` — the file has moved through 04–07
 * Purchase (P1–P9, C1–C7) — likewise, from 03 §3–§4: where and how much (`preapproval.where`), identity (`identity.verified`),
 * consents (`consent.esign.active`), credit, income, about you (profile / declarations / demographics), assets (an assets
 * ConnectCard connected or `verification.received{assets}`), target and DU (`preapproval.target` or `du.findings.received`),
 * house hunting (`preapproval.letter.issued`), the contract (`contract.confirm`), the address (`application.trid_received`),
 * the LE, proceed, lock, insurance (`insurance.*`), hand-off.
 */

export interface JourneyStep { id: string; label_copy_key: string; state: "done" | "current" | "upcoming"; at: string | null }
export interface JourneyProgress { steps: JourneyStep[]; done: number; total: number }

export interface JourneyEvent { type: string; occurred_at: string; payload: Record<string, unknown> }
export interface JourneyCard { kind: string; status: string; copy_key: string; props: Record<string, unknown>; resolved_at: string | null; created_at: string }

interface Ctx {
  /** The latest event of a type (optionally where the payload matches). */
  ev(type: string | RegExp, where?: (p: Record<string, unknown>) => boolean): JourneyEvent | undefined;
  /** The earliest resolved card matching. */
  resolved(pred: (c: JourneyCard) => boolean): JourneyCard | undefined;
}
interface StepDef { id: string; label_copy_key: string; done: (c: Ctx) => string | null; started?: (c: Ctx) => boolean }

const at = (e: JourneyEvent | undefined): string | null => e?.occurred_at ?? null;
const cardAt = (c: JourneyCard | undefined): string | null => c?.resolved_at ?? c?.created_at ?? null;
const first = (...xs: (string | null)[]): string | null => xs.find((x) => x !== null) ?? null;
const connected = (vendor: string) => (c: JourneyCard): boolean => c.kind === "ConnectCard" && c.props["vendor"] === vendor && (c.props["state"] === "connected" || c.status === "resolved");
const byKey = (kind: string, ...keys: string[]) => (c: JourneyCard): boolean => c.kind === kind && keys.includes(c.copy_key);

const income = (c: Ctx): string | null => first(cardAt(c.resolved(byKey("ConfirmCard", "income.confirm.title"))), cardAt(c.resolved(connected("truv_income"))), at(c.ev("verification.received", (p) => p["kind"] === undefined || /income|employment|payroll/i.test(String(p["kind"] ?? p["verification_kind"] ?? "")))), at(c.ev("application.field.captured", (p) => p["field"] === "income")));
const aboutYou = (c: Ctx): string | null => cardAt(c.resolved(byKey("ProfileCard", "profile.title")));
const declarations = (c: Ctx): string | null => first(at(c.ev("application.declarations.answered")), cardAt(c.resolved(byKey("ChoiceCard", "declarations.title"))));
const demographics = (c: Ctx): string | null => first(at(c.ev("application.demographics.collected")), cardAt(c.resolved((x) => x.kind === "DemographicsCard")));
const credit = (c: Ctx): string | null => at(c.ev("credit.report.received"));
const le = (c: Ctx): string | null => first(at(c.ev("disclosure.le.delivered")), at(c.ev("disclosure.le.received")));
const proceed = (c: Ctx): string | null => at(c.ev("intent.to_proceed.received"));
const lock = (c: Ctx): string | null => first(at(c.ev("lock.executed")), cardAt(c.resolved(byKey("ComparisonCard", "lock.compare.title"))));
const handoff = (c: Ctx): string | null => first(at(c.ev("closing.consummated")), at(c.ev("loan.funded")));

export const REFINANCE_STEPS: readonly StepDef[] = [
  { id: "R1", label_copy_key: "journey.refi.home", done: (c) => first(cardAt(c.resolved(byKey("ConfirmCard", "refi.home.confirm", "refi.current_loan.confirm"))), at(c.ev("application.field.captured", (p) => p["field"] === "property_address"))) },
  { id: "R2", label_copy_key: "journey.refi.credit", done: credit },
  { id: "R3", label_copy_key: "journey.refi.income", done: income },
  { id: "R4", label_copy_key: "journey.refi.about_you", done: aboutYou },
  { id: "R5", label_copy_key: "journey.refi.declarations", done: declarations },
  { id: "R6", label_copy_key: "journey.refi.demographics", done: demographics },
  { id: "R7", label_copy_key: "journey.refi.application", done: (c) => at(c.ev("application.trid_received")) },
  { id: "R8", label_copy_key: "journey.refi.underwriting", done: (c) => at(c.ev("decision.issued")), started: (c) => !!(c.ev("du.submitted") ?? c.ev("du.findings.received")) },
  { id: "R9", label_copy_key: "journey.refi.terms", done: le, started: (c) => !!(c.ev("mlo.review.completed") ?? c.ev("terms.presented")) },
  { id: "R10", label_copy_key: "journey.refi.proceed", done: proceed },
  { id: "R11", label_copy_key: "journey.refi.lock", done: lock, started: (c) => !!c.ev("lock.requested") },
  { id: "R12", label_copy_key: "journey.refi.handoff", done: handoff, started: (c) => !!c.ev("clear_to_close.issued") },
];

export const PURCHASE_STEPS: readonly StepDef[] = [
  { id: "P1", label_copy_key: "journey.purchase.where", done: (c) => cardAt(c.resolved(byKey("ConfirmCard", "preapproval.where"))) },
  { id: "P2", label_copy_key: "journey.purchase.identity", done: (c) => at(c.ev("identity.verified")) },
  { id: "P3", label_copy_key: "journey.purchase.consents", done: (c) => first(at(c.ev("consent.esign.active")), at(c.ev("consent.captured", (p) => p["kind"] === "esign"))) },
  { id: "P4", label_copy_key: "journey.purchase.credit", done: credit },
  { id: "P5", label_copy_key: "journey.purchase.income", done: income },
  { id: "P6", label_copy_key: "journey.purchase.about_you", done: (c) => first(demographics(c), declarations(c), aboutYou(c)) },
  { id: "P7", label_copy_key: "journey.purchase.assets", done: (c) => first(cardAt(c.resolved(connected("plaid_assets"))), at(c.ev("verification.received", (p) => /asset/i.test(String(p["kind"] ?? p["verification_kind"] ?? ""))))) },
  { id: "P8", label_copy_key: "journey.purchase.target", done: (c) => first(cardAt(c.resolved(byKey("ConfirmCard", "preapproval.target"))), at(c.ev("du.findings.received"))) },
  { id: "P9", label_copy_key: "journey.purchase.house_hunting", done: (c) => at(c.ev("preapproval.letter.issued")) },
  { id: "C1", label_copy_key: "journey.purchase.contract", done: (c) => cardAt(c.resolved(byKey("ConfirmCard", "contract.confirm"))) },
  { id: "C2", label_copy_key: "journey.purchase.address", done: (c) => at(c.ev("application.trid_received")) },
  { id: "C3", label_copy_key: "journey.purchase.terms", done: le, started: (c) => !!(c.ev("mlo.review.completed") ?? c.ev("terms.presented")) },
  { id: "C4", label_copy_key: "journey.purchase.proceed", done: proceed },
  { id: "C5", label_copy_key: "journey.purchase.lock", done: lock, started: (c) => !!c.ev("lock.requested") },
  { id: "C6", label_copy_key: "journey.purchase.insurance", done: (c) => first(cardAt(c.resolved(connected("carrier_connect"))), at(c.ev(/^insurance\.(evidence|policy)\.(received|verified)$/))) },
  { id: "C7", label_copy_key: "journey.purchase.handoff", done: handoff, started: (c) => !!c.ev("clear_to_close.issued") },
];

/** The journey for a subject: refinance steps unless the application is a purchase; a serviced loan has no journey to show (null). */
export function journeyProgress(input: { stage: "origination" | "servicing"; transaction_type: string | null; events: readonly JourneyEvent[]; cards: readonly JourneyCard[] }): JourneyProgress | null {
  if (input.stage !== "origination") return null;
  const defs = input.transaction_type === "purchase" ? PURCHASE_STEPS : REFINANCE_STEPS;
  const ctx: Ctx = {
    ev: (type, where = () => true) => input.events.filter((e) => (typeof type === "string" ? e.type === type : type.test(e.type)) && where(e.payload)).at(-1),
    resolved: (pred) => input.cards.filter((c) => c.status === "resolved" && pred(c)).sort((a, b) => (a.resolved_at ?? a.created_at).localeCompare(b.resolved_at ?? b.created_at))[0],
  };
  const own = defs.map((d) => ({ def: d, at: d.done(ctx), started: d.started?.(ctx) ?? false }));
  // the furthest step with any evidence: every step before it is done; the first step without done evidence is current
  let furthest = -1;
  own.forEach((s, i) => { if (s.at !== null || s.started) furthest = i; });
  const steps: JourneyStep[] = [];
  let currentSet = false;
  own.forEach((s, i) => {
    const done = s.at !== null || i < furthest;
    let state: JourneyStep["state"];
    if (done) state = "done";
    else if (!currentSet) { state = "current"; currentSet = true; }
    else state = "upcoming";
    steps.push({ id: s.def.id, label_copy_key: s.def.label_copy_key, state, at: state === "done" ? s.at : null });
  });
  return { steps, done: steps.filter((s) => s.state === "done").length, total: steps.length };
}
