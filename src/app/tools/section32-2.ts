/**
 * §32.2 process-owned tools — the 45 UX commands of docs/ux/02-data-contracts.md §2 as bus tools of the `borrower-app`
 * agent, defined with `defineTools("32.2", "borrower-app", defs)`. Every tool string is one spec/registry/agents.json
 * names for 32.2; src/app/tools.test.ts refuses the rest. Spread by ./index.ts.
 *
 * The borrower-app "is the command surface of the borrower experience — every tool is one UX command of §2, issued by a
 * card resolve or a direct endpoint (§7) with idempotency key = card_instance_id, checked by the owning handler against
 * the gate named in the §2 table, and refused with {code, gate, copy_key}; the agent proposes nothing, decides nothing
 * and computes no regulatory date" (32.2 AI agent design). So each command here is a thin translation of its UX args
 * into the owning process's own bus tool (20.3 lead intake, 21.1 intake, 21.4 lock/intent, 22.x verification, 24.x,
 * 25.2 CD, 25.3 rescission, 26.2 closing, 2.x payments/autodraft, 3.x escrow, 10.1 PMI, 4.3, 12.x lossmit, 20.1 offers)
 * executed NESTED on the same command bus, as the owning agent, inside the same unit of work (`delegate`): the owning
 * tool's allowlist, guardrails, money-field protection and decision row all apply, and its refusal (CommandRefused or
 * the section's own *Refused) is what the borrower API answers as {code, gate, copy_key}. Guardrails here are only the
 * §2 preconditions the owning handler does not check itself (a running clock, a row state, the fresh-L1 rule, the
 * chat/voice rules of 01 §3). Where the mapped domain tool does not exist yet the command runs against the domain
 * directly and says so in `direct_to_ops` (docs/ux/BACKEND-DELTAS.md: DELTA-01 preapproval, the 21.2 LE
 * deliver/receipt verbs, 23.1 createCasefile) — see DIRECT_TO_OPS below.
 *
 * Money fields (payment amounts, autodraft amounts, the escrow election) require `fresh_l1: true` (a one-time code
 * verified within 10 minutes — the API sets it from the session, never the client) and are never agent-waived.
 * `applicant_demographics` is written once from the borrower's own card and never read back (no read tool here).
 */
import { createHash, randomUUID } from "node:crypto";
import { defineTools, compute, guard, never, str, flag, cents, toolCommand, PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { CommandBus, type CommandContext } from "../commands.ts";
import { AgentRegistry, loadAgentsFile } from "../agents.ts";
import type { Queryable } from "../../infra/db/client.ts";
import { isUuid, toJson } from "../../infra/db/client.ts";
import { plainDate as D, addYears } from "../../kernel/calendar/date.ts";

export const BORROWER_APP = "borrower-app";
export const PROCESS = "32.2";

/** Commands whose mapped domain tool does not exist on the bus yet (docs/ux/BACKEND-DELTAS.md) — implemented against the domain ops directly, noted in every response as `direct_to_ops`. */
export const DIRECT_TO_OPS: Readonly<Record<string, string>> = {
  "application.answerDeclarations": "21.1 has no declarations tool: the `declarations` row is written to the entity store with `application.declarations.answered`",
  "application.inviteParty": "21.1 has no inviteParty tool: the application_borrowers / parties / conversations rows are written with the command (`application.party.invited`)",
  "disclosure.acknowledgeReceipt": "for an LE: 21.2's receipt verb is a LoanEstimateService method, not a bus tool — `disclosure.le.received{receipt_evidence=esign_confirmed}` is appended and the disclosures row moved to received (a CD goes through 25.2 recordReceipt)",
  "counteroffer.respond": "a decline: 21.6 has no borrower-side decline tool — `counteroffer.declined` is appended for the underwriter's adverse path (an accept goes through 21.6 writeDecision{counteroffer_accept})",
  "application.withdraw": "before a 21.6 decision file exists: `application.withdrawn` is appended directly (with a decision file it goes through 21.6 writeDecision{withdrawal})",
  "party.updateContact": "4.x has no contact-update tool: parties.contact / application_borrowers.contact are updated with the command (`party.contact.updated`); an address change on a serviced loan also opens the 10.1 case",
  "offer.respond": "`never`: the marketing consents are revoked on the consents table with the command (`consent.marketing.revoked`) beside 20.1's decline",
  "human.request": "pre-funding without a 20.3 lead: `human.transfer.requested` is appended and the human_agent escalation opened directly (a serviced loan goes through 4.3 human.transfer; a lead through 20.3 transfer_to_human)",
  "explanation.submit": "the letter document row (class explanation_letter / inquiry_explanation) is written with the command before 22.1 ingestDocument classifies it",
  "party.startIdentity": "DELTA-07/22.6: the vendor session is opened by the API (Stripe Identity FAKE); the command records the vendor result through 22.6 verifyIdentity",
};

// ---------------------------------------------------------------- helpers
const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const appOf = (i: ToolInput, ctx: CommandContext): string => str(i, "application_id") || ctx.applicationId || "";
const loanOf = (i: ToolInput, ctx: CommandContext): string => str(i, "loan_id") || ctx.loanId || "";
const needApp = (i: ToolInput, ctx: CommandContext): string => { const a = appOf(i, ctx); if (!a) throw new RangeError("application_id is required (an origination subject)"); return a; };
const needLoan = (i: ToolInput, ctx: CommandContext): string => { const l = loanOf(i, ctx); if (!l) throw new RangeError("loan_id is required (a serviced loan)"); return l; };
const obj = (i: ToolInput, k: string): Record<string, unknown> => ((i[k] && typeof i[k] === "object" && !Array.isArray(i[k]) ? (i[k] as Record<string, unknown>) : {}));
const list = (i: ToolInput, k: string): unknown[] => (Array.isArray(i[k]) ? (i[k] as unknown[]) : []);
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const dbOf = (rt: ToolRuntime): Queryable => { const db = rt.services["db"] as Queryable | undefined; if (!db) throw new PortUnavailable("service:db"); return db; };
const defer = (rt: ToolRuntime, fn: (q: Queryable) => Promise<void>): void => { const d = rt.services["deferWrite"] as ((fn: (q: Queryable) => Promise<void>) => void) | undefined; if (!d) throw new PortUnavailable("service:deferWrite"); d(fn); };
const hasEvent = (ctx: CommandContext, type: string | RegExp, where: (p: Record<string, unknown>) => boolean = () => true): boolean => ctx.events.all().some((e) => (typeof type === "string" ? e.type === type : type.test(e.type)) && where(e.payload as Record<string, unknown>));
const timerRunning = (ctx: CommandContext, code: string): boolean => ctx.timers.open().some((t) => t.code === code);
const cardId = (i: ToolInput): string | null => (str(i, "card_instance_id") ? str(i, "card_instance_id") : null);

let agentsFile: ReturnType<typeof loadAgentsFile> | undefined;
const escalatesTo = (process: string): readonly string[] => { agentsFile ??= loadAgentsFile(); return agentsFile.processes.find((p) => p.process === process)?.escalates_to ?? []; };
let fallbackRegistry: AgentRegistry | undefined;

/**
 * Execute another process's bus tool inside this command's unit of work, as that tool's own agent: the owning
 * handler's allowlist, guardrails, money fields and decision row apply; its refusal propagates as-is. The registry is
 * the runtime's live one when the runtime lends it (`services.agents`: AI-off and kill-switch state included).
 */
export async function delegate(rt: ToolRuntime, ctx: CommandContext, process: string, name: string, input: ToolInput): Promise<unknown> {
  const { ALL_TOOLS } = await import("./index.ts");
  const def = ALL_TOOLS.find((t) => t.process === process && t.name === name);
  if (!def) throw new PortUnavailable(`tool:${process} ${name}`);
  let agents = rt.services["agents"] as AgentRegistry | undefined;
  if (!agents) { fallbackRegistry ??= new AgentRegistry(); agents = fallbackRegistry; }
  agents.registerTool(def.agent, def.name);
  const cmd = toolCommand(def, rt, escalatesTo(process));
  const r = await new CommandBus(agents).execute(cmd, { kind: "agent", id: def.agent }, input, ctx, ctx.run ? { run: ctx.run } : {});
  return r.output;
}

/** The 32.2 decision record: {command, card_instance_id, party_id, subject, gate, outcome} in the row's fields (32.2 AI agent design). */
const decisionFor = (name: string) => (i: ToolInput, out: unknown, ctx: CommandContext) => {
  const o = out as Record<string, unknown> | null;
  const subject = cardId(i) ? { kind: "card_instance", id: cardId(i)! } : appOf(i, ctx) ? { kind: "application", id: appOf(i, ctx) } : loanOf(i, ctx) ? { kind: "loan", id: loanOf(i, ctx) } : undefined;
  return { action: `borrower.command:${name}`, rationale: `command=${name} party_id=${str(i, "party_id") || "-"} card_instance_id=${cardId(i) ?? "-"} outcome=${o && typeof o["outcome"] === "string" ? o["outcome"] : "accepted"} gate=${o && typeof o["gate"] === "string" ? o["gate"] : "-"} by ${ctx.actor.kind}:${ctx.actor.id}`, ...(subject ? { subject } : {}), ...(typeof i.rule_code === "string" ? { ruleCode: i.rule_code } : {}) };
};
const FRESH_L1 = guard("FRESH_L1_REQUIRED", "01 §5 / 32.2 guardrails: money fields require a fresh L1 code within 10 minutes and never an agent-side waiver", (i) => (i.fresh_l1 === true ? undefined : "a one-time code verified within 10 minutes is required (fresh_l1 is set by the API from the session)"));
const NOT_VOICE = (what: string) => never("CONSENT_VOICE_VOID", "01 §3.5 / 15 U.S.C. 7001(c)(6): a spoken yes never resolves a consent — the card is sent, never resolved, by voice", (i) => str(i, "channel") === "voice", `${what} cannot be captured on a voice channel; the card link is sent instead`);
const LEVEL_RANK: Record<string, number> = { L1: 1, L2: 2, L3: 3 };
const levelAtLeast = (i: ToolInput, level: string): boolean => (str(i, "assurance_level") ? (LEVEL_RANK[str(i, "assurance_level")] ?? 0) >= (LEVEL_RANK[level] ?? 0) : true);
const CARD_KINDS = ["StatusCard", "ChoiceCard", "ConfirmCard", "ConnectCard", "ConsentCard", "DocumentCard", "ComparisonCard", "ChecklistCard", "UploadCard", "ExplanationCard", "ScheduleCard", "PaymentCard", "InviteCard", "HandoffCard", "OfferCard", "NoticeCard", "PersonCard", "ProfileCard", "DemographicsCard"] as const;
export const CARD_KIND_SET: ReadonlySet<string> = new Set(CARD_KINDS);
const SIX_ITEMS = new Set(["name", "income", "ssn", "property_address", "property_value_estimate", "loan_amount_sought"]);
const CASE_KINDS = new Set(["rfi", "noe", "complaint", "payoff_request", "address_change", "general_inquiry"]);
const ok = (name: string, extra: Record<string, unknown>): Record<string, unknown> => ({ command: name, outcome: "accepted", ...(DIRECT_TO_OPS[name] ? { direct_to_ops: DIRECT_TO_OPS[name] } : {}), ...extra });

// ---------------------------------------------------------------- 32.3: the multi-field ConfirmCard / ProfileCard resolves (E5, R1, R3, R4, R7, P1, P8, C1) and the E-SIGN demonstration test
/** 7.4's demonstration test, FAKE: the code printed in the verification e-mail's PDF is derived from the consent id (a real mailer holds it out of band). */
export const esignVerificationToken = (consentId: string): string => sha(`esign-verify:${consentId}`).slice(0, 6).toUpperCase();
/** 32.13 / BACKEND-DELTAS §3: the 0009 `consents.scope` vocabulary (disclosures, notices, esign_signatures, enote, the servicing classes) → 20.3's E-SIGN class names. */
export const esignClassesOf = (scopes: readonly string[]): string[] => [...new Set(scopes.map((s) => (s === "disclosures" || s === "notices" || s === "origination_disclosures" ? "origination_disclosures" : s === "esign_signatures" || s === "enote" || s === "origination_esign_signatures" ? "origination_esign_signatures" : "servicing_communications")))];
interface ConfirmedField { readonly path: string; readonly value: string; readonly source: string }
/** The card's confirmed fields as the API hands them over (`fields[]`: value + the source the API settled — `borrower` where the value was edited). */
const fieldsOf = (i: ToolInput): ConfirmedField[] => list(i, "fields").map((f) => { const o = (f && typeof f === "object" ? f : {}) as Record<string, unknown>; const v = o["value"] !== undefined && o["value"] !== null ? o["value"] : o["value_confirmed"]; return { path: String(o["path"] ?? ""), value: v === undefined || v === null ? "" : String(v), source: String(o["source"] ?? "borrower") }; }).filter((f) => f.path);
/** 21.1's six items ↔ 20.3's `trid_items` keys (the lead's evidence of the TRID anchor — 20.3 T5, 32.3 T8/T18). */
const TRID_ITEM_OF: Readonly<Record<string, string>> = { name: "name", legal_name: "name", income: "income", ssn: "ssn_for_credit", property_address: "property_address", property_value_estimate: "value_estimate", loan_amount_sought: "loan_amount_sought" };
async function recordLeadTridItem(rt: ToolRuntime, ctx: CommandContext, i: ToolInput, item: string, source: string, value: string): Promise<unknown> {
  const lead_id = str(i, "lead_id"); const trid = TRID_ITEM_OF[item]; if (!lead_id || !trid || !rt.store.get("leads", lead_id)) return null;
  // an accepted prefill is `on_file_confirmed`; a typed value is `consumer_stated`; income is always the consumer's own statement for the new transaction (20.3 rule 5); the SSN itself never travels
  const tridSource = item === "income" || source === "borrower" ? "consumer_stated" : "on_file_confirmed";
  return delegate(rt, ctx, "20.3", "explainProgram", { op: "record_trid_item", lead_id, item: trid, source: tridSource, value: item === "ssn" ? "ssn:provided" : value });
}
/** A six-item write: a typed/edited value is `borrower_stated` (captureField); an accepted prefill is `borrower_confirmed_prefill` (confirmPrefill) — 21.1 rule 1 / 21.2 rule 2. */
const captureSix = (rt: ToolRuntime, ctx: CommandContext, application_id: string, item: string, value: string, source: string, borrower_id: string | undefined): Promise<Record<string, unknown>> =>
  (source === "borrower" ? delegate(rt, ctx, "21.1", "captureField", { application_id, field: item, value, ...(borrower_id ? { borrower_id } : {}) }) : delegate(rt, ctx, "21.1", "confirmPrefill", { application_id, item, value, ...(borrower_id ? { borrower_id } : {}), confirmed: true })) as Promise<Record<string, unknown>>;
async function confirmFields(i: ToolInput, ctx: CommandContext, rt: ToolRuntime, application_id: string, path: string): Promise<Record<string, unknown>> {
  const fields = fieldsOf(i); const abId = isUuid(str(i, "application_borrower_id")) ? str(i, "application_borrower_id") : ""; const borrower_id = str(i, "borrower_id") || undefined; const now = ctx.now;
  const get = (p: string): ConfirmedField | undefined => fields.find((f) => f.path === p && f.value !== "");
  const need_ = (p: string): ConfirmedField => { const f = get(p); if (!f) throw new RangeError(`${p} is required`); return f; };
  const results: Record<string, unknown> = {}; let trid: Record<string, unknown> | null = null;
  // application_borrowers.prefill[item] = {value, source, confirmed_at}: the confirmed fact beside its provenance (01 §3.3; T5)
  const prefill = (item: string, f: ConfirmedField): void => { if (abId) defer(rt, async (q) => { await q.query(`UPDATE application_borrowers SET prefill = jsonb_set(prefill, ARRAY[$2], coalesce(prefill->$2, '{}'::jsonb) || $3::jsonb) WHERE id = $1`, [abId, item, toJson({ value: f.value, source: f.source, confirmed_at: now })]); }); };
  const plain = (field: string, value: string): Promise<unknown> => delegate(rt, ctx, "21.1", "captureField", { application_id, field, value, ...(borrower_id ? { borrower_id } : {}) });
  switch (path) {
    case "identity": {   // E5: name → the six-item `name`; DOB and current address are plain fields (each with its source and confirmed_at)
      const name = get("legal_name"); const dob = get("date_of_birth"); const addr = get("current_address");
      if (name) { trid = await captureSix(rt, ctx, application_id, "name", name.value, name.source, borrower_id); prefill("legal_name", name); await recordLeadTridItem(rt, ctx, i, "name", name.source, name.value); if (abId) defer(rt, async (q) => { await q.query(`UPDATE application_borrowers SET legal_name = $2 WHERE id = $1`, [abId, name.value]); }); }
      if (dob) { await plain("date_of_birth", dob.value); prefill("date_of_birth", dob); if (abId && /^\d{4}-\d{2}-\d{2}$/.test(dob.value)) defer(rt, async (q) => { await q.query(`UPDATE application_borrowers SET date_of_birth = $2::date WHERE id = $1`, [abId, dob.value]); }); }
      if (addr) { await plain("current_address", addr.value); prefill("current_address", addr); }
      break;
    }
    case "ssn": {   // E5: the one typed field — stored once (last four beside the encrypted TIN's slot), never echoed, never in prefill
      const f = need_("ssn"); const digits = f.value.replace(/\D/g, ""); if (digits.length !== 9) throw new RangeError("ssn must be nine digits");
      trid = await captureSix(rt, ctx, application_id, "ssn", f.value, "borrower", borrower_id); await recordLeadTridItem(rt, ctx, i, "ssn", "borrower", "ssn:provided");
      if (abId) defer(rt, async (q) => { await q.query(`UPDATE application_borrowers SET tin_last4 = $2 WHERE id = $1`, [abId, digits.slice(-4)]); });
      results["ssn"] = "stored"; break;
    }
    case "property_address": {   // R1: the address counts as the six-item property address when confirmed (20.3 T5 / 32.3 T8); type, units and occupancy are plain fields
      const f = need_("property_address"); trid = await captureSix(rt, ctx, application_id, "property_address", f.value, f.source, borrower_id); await recordLeadTridItem(rt, ctx, i, "property_address", f.source, f.value);
      for (const k of ["property_type", "units", "occupancy"]) { const x = get(k); if (x) await plain(k, x.value); }
      break;
    }
    case "income": {   // R3: Confirm = the borrower's stated income for this transaction (21.2 rule 2); the row keeps the source and the confirmation time (T11)
      const base = need_("monthly_base_cents"); const amount = cents(base.value); if (amount < 0n) throw new RangeError("monthly_base_cents must be non-negative");
      const source = base.source === "borrower" ? "borrower" : "payroll_connection";
      trid = await captureSix(rt, ctx, application_id, "income", amount.toString(), source === "borrower" ? "borrower" : "payroll_connection", borrower_id); await recordLeadTridItem(rt, ctx, i, "income", source, amount.toString());
      const employer = { name: get("employer")?.value ?? null, position: get("position")?.value ?? null, start_date: get("start_date")?.value ?? null, pay_frequency: get("pay_frequency")?.value ?? null, source: get("employer")?.source ?? source };
      const calculation = { source, confirmed_at: now, verification_id: str(i, "verification_id") || null, report_reference_id: str(i, "report_reference_id") || null, card_instance_id: cardId(i), variable_monthly_cents: cents(get("monthly_variable_cents")?.value ?? "0").toString(), other_income: get("other_income")?.value ?? "none", vendor: source === "payroll_connection" ? "FAKE:truv_income" : null };
      if (abId) defer(rt, async (q) => { await q.query(`INSERT INTO application_income (application_id, application_borrower_id, source_kind, employer, monthly_amount_cents, qualifying, calculation) VALUES ($1, $2, 'base', $3::jsonb, $4, true, $5::jsonb)`, [application_id, abId, toJson(employer), amount.toString(), toJson(calculation)]); });
      results["amount_cents"] = amount.toString(); results["source"] = source; break;
    }
    case "profile": {   // R4: four required taps and the Form 1103 language preference — each a ULAD-validated field on the borrower (T13: nothing without the tap)
      need_("citizenship_status"); need_("marital_status"); need_("dependents"); need_("military_service");
      for (const k of ["citizenship_status", "marital_status", "language_preference", "dependents", "military_service", "dependents_ages"]) { const x = get(k); if (x) await plain(k, k === "language_preference" && x.value === "" ? "not_answered" : x.value); }
      if (abId) { const c = get("citizenship_status")!.value; const m = get("marital_status")!.value; const l = get("language_preference")?.value ?? "not_answered"; defer(rt, async (q) => { await q.query(`UPDATE application_borrowers SET citizenship_status = $2, marital_status = $3, language_preference = $4 WHERE id = $1`, [abId, c, m, l]); }); }
      break;
    }
    case "ssn_on_file": {   // 32.11 §3: a returning borrower's SSN is on file (captured once at the prior origination, 01 §5) — confirming the offered prefill counts as the six-item `ssn`; nothing is re-typed and nothing travels
      need_("ssn_on_file"); trid = await delegate(rt, ctx, "21.1", "confirmPrefill", { application_id, item: "ssn", ...(borrower_id ? { borrower_id } : {}), confirmed: true }) as Record<string, unknown>; await recordLeadTridItem(rt, ctx, i, "ssn", "prior_application", "ssn:on_file");
      results["ssn"] = "on_file"; break;
    }
    case "property_value_estimate": case "loan_amount_sought": {   // R7: an accepted AVM / payoff-based amount counts at the tap; an edit is the borrower's own number (T18)
      const f = need_(path); const amount = cents(f.value).toString(); trid = await captureSix(rt, ctx, application_id, path, amount, f.source, borrower_id); await recordLeadTridItem(rt, ctx, i, path, f.source, amount); results["source"] = f.source; break;
    }
    case "purchase_contract": {   // C1/C2: the extracted fields count only on Confirm; the address completes the six items (T29); the purchase_contracts row is written here
      const addr = get("property_address"); const price = get("purchase_price_cents"); if (!addr && !price) throw new RangeError("property_address or purchase_price_cents is required");
      if (price) { const v = cents(price.value).toString(); await captureSix(rt, ctx, application_id, "property_value_estimate", v, price.source, borrower_id); await recordLeadTridItem(rt, ctx, i, "property_value_estimate", price.source, v); }
      if (addr) { trid = await captureSix(rt, ctx, application_id, "property_address", addr.value, addr.source, borrower_id); await recordLeadTridItem(rt, ctx, i, "property_address", addr.source, addr.value); }
      const document_id = str(i, "document_id"); const confirmed = Object.fromEntries(fields.map((f) => [f.path, { value: f.value, source: f.source, confirmed_at: now }]));
      rt.store.put("purchase_contracts", document_id || `${application_id}:contract`, { application_id, document_id: document_id || null, fields: confirmed, confirmed_at: now, card_instance_id: cardId(i) }, ctx.actor, ctx.now);
      const dateOr = (k: string): string | null => { const v = get(k)?.value ?? ""; return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null; };
      if (price) defer(rt, async (q) => { await q.query(`INSERT INTO purchase_contracts (application_id, document_id, sales_price_cents, seller_concessions_cents, contract_date, closing_date) VALUES ($1, $2, $3, $4, $5::date, $6::date)`, [application_id, isUuid(document_id) ? document_id : null, cents(price.value).toString(), cents(get("seller_concessions_cents")?.value ?? "0").toString(), dateOr("contract_date"), dateOr("closing_date")]); });
      ctx.events.append({ type: "purchase_contract.confirmed", applicationId: application_id, actor: ctx.actor, payload: { application_id, document_id: document_id || null, fields: Object.keys(confirmed), card_instance_id: cardId(i) } });
      break;
    }
    case "preapproval.where": {   // P1: the state (SM_LICENSE_STATE_GATE), the price range and down payment → 20.3's prequalification request (kind preapproval — DELTA-01)
      const state = need_("state"); const lo = cents(need_("price_min_cents").value); const hi = cents(need_("price_max_cents").value); const down = cents(need_("down_payment_cents").value);
      await plain("property_state", state.value); const range = [lo > down ? lo - down : 0n, hi > down ? hi - down : 0n];
      if (str(i, "lead_id") && rt.store.get("leads", str(i, "lead_id"))) results["prequal"] = await delegate(rt, ctx, "20.3", "explainProgram", { op: "request_prequal", lead_id: str(i, "lead_id"), prequal_id: str(i, "prequal_id") || `PQ-${application_id.slice(0, 8)}`, kind: "preapproval", value_estimate_cents: hi.toString(), loan_amount_range_cents: [range[0]!.toString(), range[1]!.toString()], first_time_buyer: get("first_time_buyer")?.value === "yes" });
      results["state"] = state.value; break;
    }
    case "preapproval.target": {   // P8: target price, down payment and the loan amount (typed) — the value and amount items for the TBD casefile
      const price = cents(need_("target_price_cents").value).toString(); const loan = cents(need_("loan_amount_sought").value).toString();
      await captureSix(rt, ctx, application_id, "property_value_estimate", price, "borrower", borrower_id); await recordLeadTridItem(rt, ctx, i, "property_value_estimate", "borrower", price);
      trid = await captureSix(rt, ctx, application_id, "loan_amount_sought", loan, "borrower", borrower_id); await recordLeadTridItem(rt, ctx, i, "loan_amount_sought", "borrower", loan);
      const product = get("product_code"); if (product) await plain("product_code", product.value); const down = get("down_payment_cents"); if (down) await plain("down_payment_cents", cents(down.value).toString());
      break;
    }
    case "liabilities": case "current_loan": {   // R1/R2: the confirmed liabilities (source credit_report) as the borrower's own statement beside 22.5's rows
      const id = `${application_id}:${borrower_id ?? abId ?? "all"}:${path}`;
      rt.store.put("application_liabilities", id, { application_id, borrower_id: borrower_id ?? abId ?? null, kind: path, report_id: str(i, "report_id") || null, fields: fields.map((f) => ({ ...f, confirmed_at: now })), confirmed_at: now, card_instance_id: cardId(i) }, ctx.actor, ctx.now);
      ctx.events.append({ type: "application.liabilities.confirmed", applicationId: application_id, actor: ctx.actor, payload: { application_id, borrower_id: borrower_id ?? null, kind: path, count: fields.length, card_instance_id: cardId(i) } });
      break;
    }
    default: for (const f of fields) await plain(f.path, f.value);
  }
  return ok("application.confirmField", { application_id, path, fields: fields.map((f) => ({ path: f.path, source: f.source })), confirmed_at: now, six_items_complete: trid?.["six_items_complete"] ?? null, trid_emitted: trid?.["trid_emitted"] ?? false, ...results });
}

type Def = Omit<ToolDef, "process" | "agent">;
/** DELTA-16: link-my-loan refused — one code for any mismatch, never which field (32.14 §2 S6). */
export class LinkLoanRefused extends RangeError { readonly code = "LINK_LOAN_MISMATCH"; constructor() { super("LINK_LOAN_MISMATCH: the facts did not match a loan on file"); this.name = "LinkLoanRefused"; } }
/** The tool strings spec/registry/agents.json names for a process (tools/extract_agents.py reads the spec's agent-design paragraphs; src/app/tools.test.ts refuses anything else on the bus). */
export const specToolNames = (process: string): ReadonlySet<string> => { agentsFile ??= loadAgentsFile(); return new Set(agentsFile.processes.find((p) => p.process === process)?.tools ?? []); };
const cmd = (name: string, kind: ToolDef["kind"], handler: (i: ToolInput, ctx: CommandContext, rt: ToolRuntime) => unknown | Promise<unknown>, extra: Partial<Def> = {}): Def =>
  ({ name, kind, handler: compute(handler), decision: decisionFor(name), ...extra });

/**
 * 32.14 DELTA-16 (docs/ux/15 §2 S6, §6): `party.linkLoan{loan_last4 | property_zip, ssn_last4, date_of_birth}` — a servicing-book
 * borrower whose contact is not on file (a Google e-mail that created a new party) links their loan by facts only they would know:
 * an exact match of every fact given against the book's own rows (borrowers ↔ loan_borrowers ↔ loans ↔ properties) sets
 * `borrowers.party_id` on the matched rows and raises the party's live sessions to L2 (the same on-file facts /auth/l2 matches —
 * 01 §5); any mismatch refuses `LINK_LOAN_MISMATCH` without saying which field (nothing is written). A borrower already linked to
 * another party never re-links. Event `party.loan.linked{party_id, borrower_id, loan_id, matched_by, level}` on the loan.
 *
 * Defined beside 32.2's helpers; registered by section32-14.ts as a 32.14 tool (32.2's table keeps its 45) — and only once
 * spec/registry/agents.json names `party.linkLoan` for 32.14 (src/app/tools.test.ts refuses an unlisted tool; tools/extract_agents.py
 * reads the spec's agent-design paragraphs). Until then the API answers COMMAND_UNKNOWN and this definition waits here, exported.
 */
export const LINK_LOAN_DEF: Def = cmd("party.linkLoan", "write", async (i, ctx, rt) => {
  const party_id = str(i, "party_id"); if (!party_id) throw new RangeError("party_id is required (the API states it from the session)");
  const last4 = str(i, "ssn_last4"); const dob = str(i, "date_of_birth"); const loanLast4 = str(i, "loan_last4"); const zip = str(i, "property_zip").slice(0, 5);
  if (!/^\d{4}$/.test(last4) || !/^\d{4}-\d{2}-\d{2}$/.test(dob) || (!/^\d{4}$/.test(loanLast4) && !/^\d{5}$/.test(zip))) throw new RangeError("loan_last4 (4 digits) or property_zip (5 digits), ssn_last4 (4 digits) and date_of_birth (YYYY-MM-DD) are required");
  const rows = await dbOf(rt).query<{ borrower_id: string; loan_id: string; party_id: string | null }>(
    `SELECT b.id AS borrower_id, l.id AS loan_id, b.party_id FROM borrowers b JOIN loan_borrowers lb ON lb.borrower_id = b.id JOIN loans l ON l.id = lb.loan_id JOIN properties p ON p.id = l.property_id
       WHERE b.tin_last4 = $1 AND b.date_of_birth = $2::date AND (($3 <> '' AND right(l.servicer_loan_number, 4) = $3) OR ($4 <> '' AND left(p.postal_code, 5) = $4))`, [last4, dob, loanLast4, zip]);
  const mine = rows.filter((r) => r.party_id === null || r.party_id === party_id);
  if (!mine.length) throw new LinkLoanRefused();   // never which field (the API logs the attempt, never the values)
  const now = ctx.now; const matched_by = loanLast4 ? "loan_last4" : "property_zip";
  defer(rt, async (q) => {
    for (const r of mine) await q.query(`UPDATE borrowers SET party_id = $2 WHERE id = $1 AND party_id IS NULL`, [r.borrower_id, party_id]);
    await q.query(`UPDATE sessions SET level = 'L2' WHERE party_id = $1 AND revoked_at IS NULL AND expires_at > $2 AND level = 'L1'`, [party_id, now]);   // the session rises to L2
  });
  for (const r of mine) ctx.events.append({ type: "party.loan.linked", loanId: r.loan_id, actor: ctx.actor, payload: { party_id, borrower_id: r.borrower_id, loan_id: r.loan_id, matched_by, level: "L2", card_instance_id: cardId(i) } });
  return ok("party.linkLoan", { party_id, loans: [...new Set(mine.map((r) => r.loan_id))], matched_by, level: "L2" });
}, { guardrails: [never("LEVEL_REQUIRED", "01 §5: linking a loan starts from an L1 session", (i) => !levelAtLeast(i, "L1"), "an L1 session is required")] });

// ---------------------------------------------------------------- the 45 commands (02 §2 order)
export const TOOLS_32_2: readonly ToolDef[] = defineTools(PROCESS, BORROWER_APP, [
  // lead.start → 20.3 deliverDisclosure{create} then {start}: `lead.created`, `lead.interaction.started{channel, ai}`
  cmd("lead.start", "act", async (i, ctx, rt) => {
    need(i, "partner_id", "partner_name");
    const lead_id = str(i, "lead_id") || randomUUID(); const interaction_id = str(i, "interaction_id") || randomUUID();
    const created = await delegate(rt, ctx, "20.3", "deliverDisclosure", { op: "create", lead_id, partner_id: str(i, "partner_id"), partner_name: str(i, "partner_name"), channel: str(i, "lead_channel") || "organic", consumer_state: str(i, "consumer_state") || null, property_state: str(i, "property_state") || str(i, "consumer_state") || null, transaction_intent: str(i, "transaction_intent") || "undecided", party_id: str(i, "party_id") || null, prospect: Object.keys(obj(i, "prospect")).length ? obj(i, "prospect") : null, source_touch_id: str(i, "utm_touch_id") || null, opportunity_id: str(i, "opportunity_id") || null, time_zone: str(i, "time_zone") || "America/New_York", utm: obj(i, "utm") }) as Record<string, unknown>;
    const started = await delegate(rt, ctx, "20.3", "deliverDisclosure", { op: "start", lead_id, interaction_id, channel: str(i, "channel") || "web_chat", ai: true }) as Record<string, unknown>;
    return ok("lead.start", { lead_id, interaction_id, status: created["status"], disclosure_required: started["disclosure_required"], co_preuse_notice: started["co_preuse_notice"] ?? null });
  }),
  // lead.acknowledgeAiDisclosure → 20.3 deliverDisclosure: `lead.disclosure.delivered`, `consent.ai_disclosure.acknowledged`
  cmd("lead.acknowledgeAiDisclosure", "act", async (i, ctx, rt) => {
    need(i, "lead_id", "interaction_id");
    const r = await delegate(rt, ctx, "20.3", "deliverDisclosure", { lead_id: str(i, "lead_id"), interaction_id: str(i, "interaction_id"), notice_id: str(i, "notice_id") || null, ...(str(i, "disclosure_version_id") ? { version: str(i, "disclosure_version_id") } : {}) }) as Record<string, unknown>;
    // 7.4 rule 13 / 32.13 T-X-01: the acknowledgment is per session, on every channel, origination and servicing alike — the 20.3 delivery is the disclosure; this is the party's session acknowledging it (no tap: logged on the render)
    ctx.events.append({ type: "consent.ai_disclosure.acknowledged", ...(appOf(i, ctx) ? { applicationId: appOf(i, ctx) } : {}), ...(loanOf(i, ctx) ? { loanId: loanOf(i, ctx) } : {}), actor: ctx.actor, payload: { lead_id: str(i, "lead_id"), interaction_id: str(i, "interaction_id"), party_id: str(i, "party_id") || null, consent_id: r["consent_id"] ?? null, version: r["version"] ?? null, session_id: str(i, "session_id") || null, channel: str(i, "channel") || null, acknowledged_at: ctx.now } });
    return ok("lead.acknowledgeAiDisclosure", { lead_id: str(i, "lead_id"), consent_id: r["consent_id"], version: r["version"], text: r["text"] });
  }),
  // party.authenticate → 20.3 authenticate{method}: `lead.authenticated{level}` (the session itself is the API's — 01 §5)
  cmd("party.authenticate", "act", async (i, ctx, rt) => {
    need(i, "lead_id", "method");
    const m = str(i, "method"); const method = m === "otp_phone" ? "otp_sms" : m === "passkey" ? "otp_email" : m;
    const r = await delegate(rt, ctx, "20.3", "authenticate", { lead_id: str(i, "lead_id"), method, evidence: { ...obj(i, "evidence"), session_id: str(i, "session_id") || null, auth_method: m } }) as Record<string, unknown>;
    return ok("party.authenticate", { lead_id: str(i, "lead_id"), level: r["level"] });
  }),
  // party.startIdentity → 22.6 verifyIdentity (the vendor's result; SM_IDENTITY_IAL2_GATE satisfies when the last borrower verifies)
  cmd("party.startIdentity", "act", async (i, ctx, rt) => {
    const application_id = needApp(i, ctx); need(i, "borrower_id", "result");
    const r = await delegate(rt, ctx, "22.6", "verifyIdentity", { application_id, borrower_id: str(i, "borrower_id"), method: str(i, "method") || "remote_doc_biometric", result: i.result, borrower_ids: list(i, "borrower_ids").length ? i.borrower_ids : [str(i, "borrower_id")], consent_id: cardId(i) || str(i, "vendor_session_id") || null, at: ctx.now }) as Record<string, unknown>;
    return ok("party.startIdentity", { application_id, vendor: str(i, "vendor") || "stripe_identity", identity_outcome: r["outcome"], level: r["level"], all_borrowers_verified: r["all_borrowers_verified"] });
  }, { guardrails: [never("LEVEL_REQUIRED", "01 §5: identity proofing starts from an L1 session", (i) => !levelAtLeast(i, "L1"), "an L1 session is required")] }),
  // consent.capture → 20.3 captureConsent (a lead) or 2.3 consent.capture (a loan); the consents row is written with the command (7.4: consent is per party)
  cmd("consent.capture", "write", async (i, ctx, rt) => {
    if (flag(i, "withdraw")) {   // 32.11 §5 (DELTA-05) / 7.4: the borrower withdraws a consent from the Loan section (a ChoiceCard tap) — the rows keep their history; `consent.<kind>.withdrawn` (02 §1.3); rows of other kinds and purposes stay
      need(i, "kind", "party_id"); const kind = str(i, "kind"); const platformKind = kind === "autodraft_authorization" ? "autopay" : kind; const party_id = str(i, "party_id"); const now = ctx.now; const purpose = str(i, "purpose") || null; const only = str(i, "consent_id") || null;
      defer(rt, async (q) => { await q.query(`UPDATE consents SET status = 'withdrawn', revoked_at = $3, withdrawal_channel = 'portal', withdrawal_reason = $4 WHERE party_id = $1 AND kind = $2::consent_kind AND ($5::text IS NULL OR purpose = $5) AND ($6::text IS NULL OR id::text = $6) AND (status IS NULL OR status NOT IN ('withdrawn', 'revoked'))`, [party_id, platformKind, now, str(i, "reason") || "borrower_withdrew", purpose, only]); });
      ctx.events.append({ type: `consent.${kind}.withdrawn`, ...(loanOf(i, ctx) ? { loanId: loanOf(i, ctx) } : {}), ...(appOf(i, ctx) ? { applicationId: appOf(i, ctx) } : {}), actor: ctx.actor, payload: { kind: platformKind, ux_kind: kind, party_id, purpose, consent_id: only, withdrawn_at: now, channel: "portal", reason: str(i, "reason") || "borrower_withdrew", card_instance_id: cardId(i) } });
      return ok("consent.capture", { consent_id: only, kind: platformKind, status: "withdrawn", party_id, withdrawn_at: now });
    }
    if (str(i, "op") === "verify") {   // 32.3 E6 / 7.4 rule 2: the demonstration test — the e-mailed link + PDF code; only now does the esign row become `active` (never a spoken or typed yes)
      need(i, "consent_id", "token", "party_id"); const consent_id = str(i, "consent_id"); const party_id = str(i, "party_id"); const now = ctx.now;
      if (str(i, "token").trim().toUpperCase() !== esignVerificationToken(consent_id)) throw new RangeError("the verification code did not match the one in the attached PDF (FAKE mailer)");
      const scope = list(i, "scope").length ? list(i, "scope").map(String) : ["disclosures", "notices"]; const application_id = appOf(i, ctx) || null;
      defer(rt, async (q) => { await q.query(`UPDATE consents SET status = 'active', verified = true WHERE id = $1 AND kind = 'esign' AND party_id = $2`, [consent_id, party_id]); });
      const sub = application_id ? { applicationId: application_id } : {};
      ctx.events.append({ type: "consent.esign.verified", ...sub, actor: ctx.actor, payload: { consent_id, party_id, verified_at: now, method: "email_link_pdf_token", vendor: "FAKE", card_instance_id: cardId(i) } });
      ctx.events.append({ type: "consent.esign.active", ...sub, actor: ctx.actor, payload: { consent_id, party_id, scope, activated_at: now } });
      ctx.events.append({ type: "consent.granted", ...sub, actor: ctx.actor, payload: { consent_id, kind: "esign", ux_kind: "esign", party_id, scope, status: "active", method: "checkbox_with_text", covers_origination_disclosures: scope.includes("disclosures"), verified_at: now } });
      return ok("consent.capture", { consent_id, kind: "esign", status: "active", verified: true, party_id, scope });
    }
    need(i, "kind", "party_id", "method"); const kind = str(i, "kind"); const scope = list(i, "scope").map(String); const consent_id = str(i, "consent_id") || randomUUID();
    const platformKind = kind === "autodraft_authorization" ? "autopay" : kind;
    const status = kind === "esign" ? "pending_verification" : "active";   // 7.4's consents.status vocabulary: the E-SIGN demonstration test runs out of band before `active`
    let delegated: Record<string, unknown> | null = null;
    if (str(i, "lead_id") && ["esign", "tcpa_voice", "tcpa_sms", "credit_authorization"].includes(kind)) {
      delegated = await delegate(rt, ctx, "20.3", "captureConsent", kind === "esign" ? { lead_id: str(i, "lead_id"), kind, consent_id, party_id: str(i, "party_id"), scopes: esignClassesOf(scope.length ? scope : ["disclosures", "notices"]), disclosure_version: str(i, "disclosure_version_id"), captured_via: str(i, "channel") === "voice" ? "voice" : "portal", clicked_at: ctx.now, ip: str(i, "ip") || null, user_agent: str(i, "user_agent") || null }
        : kind === "credit_authorization" ? { lead_id: str(i, "lead_id"), kind, authorization_id: consent_id, authorization_kind: str(i, "authorization_kind") || "soft_prequal", party_id: str(i, "party_id"), text_version: str(i, "text_hash") || str(i, "disclosure_version_id"), channel: "web_chat", end_user: "partner", evidence: { ip: str(i, "ip") || null, user_agent: str(i, "user_agent") || null, card_instance_id: cardId(i) } }
        : { lead_id: str(i, "lead_id"), kind, consent_id, party_id: str(i, "party_id"), number: str(i, "phone_number") }) as Record<string, unknown>;
    } else if (loanOf(i, ctx)) {
      delegated = await delegate(rt, ctx, "2.3", "consent.capture", { id: consent_id, loan_id: loanOf(i, ctx), data: { consent_id, loan_id: loanOf(i, ctx), party_id: str(i, "party_id"), kind: platformKind, scope, status, method: str(i, "method"), channel: "portal", disclosure_version_id: str(i, "disclosure_version_id") || null, text_hash: str(i, "text_hash") || null, purpose: str(i, "purpose") || "informational", captured_at: ctx.now } }) as Record<string, unknown>;
    }
    ctx.events.append({ type: `consent.granted`, ...(appOf(i, ctx) ? { applicationId: appOf(i, ctx) } : {}), ...(loanOf(i, ctx) ? { loanId: loanOf(i, ctx) } : {}), actor: ctx.actor, payload: { consent_id, kind: platformKind, ux_kind: kind, party_id: str(i, "party_id"), scope, status, method: str(i, "method"), disclosure_version_id: str(i, "disclosure_version_id") || null, card_instance_id: cardId(i), standing: flag(i, "standing") } });   // 32.11 §5: a consent captured on a serviced loan carries the loan subject too (the standing authorization's card)
    if (kind === "esign") ctx.events.append({ type: "consent.esign.pending", ...(appOf(i, ctx) ? { applicationId: appOf(i, ctx) } : {}), actor: ctx.actor, payload: { consent_id, party_id: str(i, "party_id"), scope, verification_email: "NTC_ESIGN_VERIFICATION_EMAIL" } });
    const application_id = appOf(i, ctx) || null; const loan_id = loanOf(i, ctx) || null; const party_id = str(i, "party_id"); const lead_id = str(i, "lead_id") || null;
    // consents.disclosure_version_id is a uuid (the consent_disclosure_versions row); a card's version label that is not one lands in hw_sw_version (7.4's statement version) beside the text hash
    const versionId = str(i, "disclosure_version_id"); const versionUuid = isUuid(versionId) ? versionId : null; const versionLabel = versionUuid ? null : versionId || null;
    defer(rt, async (q) => {
      // 32.13: 20.3 keeps the lead in the entity store; the 0112 `consents.lead_id` reference holds only when the lead has a `leads` row (the preapproval-letter path writes one) — the lead id stays on the event and in 20.3's record either way
      const leadRow = lead_id ? await q.query<{ lead_id: string }>(`SELECT lead_id FROM leads WHERE lead_id::text = $1`, [lead_id]) : []; const leadFk = leadRow.length ? lead_id : null;
      await q.query(`INSERT INTO consents (id, kind, granted, provenance, verified, captured_at, scope, status, disclosure_version_id, hw_sw_version, captured_via, application_id, loan_id, lead_id, party_id, purpose, disclosure_text_hash, standing, loan_ids)
      VALUES ($1, $2::consent_kind, true, 'portal', $3, $4, $5::text[], $6, $7, $8, 'portal', $9, $10, $11, $12, $13, $14, $15, $16::uuid[])`,
      [consent_id, platformKind, kind !== "esign", ctx.now, scope, status, versionUuid, versionLabel, application_id, loan_id, leadFk, party_id, str(i, "purpose") || "informational", str(i, "text_hash") || null, flag(i, "standing"), loan_id ? [loan_id] : []]); });
    return ok("consent.capture", { consent_id, kind: platformKind, status, scope, party_id, verification_email: kind === "esign" ? "NTC_ESIGN_VERIFICATION_EMAIL" : null, delegated: delegated ? Object.fromEntries(Object.entries(delegated).filter(([k]) => ["consent_id", "status", "scope", "authorization_id", "permissible_purpose"].includes(k))) : null });
  }, { guardrails: [NOT_VOICE("a consent"),
    never("AFFIRMATION_METHOD", "01 §3.5: esign / credit_authorization / autodraft_authorization need checkbox_with_text + typed name; ai_disclosure_ack a single tap", (i) => ["esign", "credit_authorization", "autodraft_authorization", "tcpa_voice", "tcpa_sms"].includes(str(i, "kind")) && str(i, "method") !== "" && str(i, "method") !== "checkbox_with_text", "this consent kind is affirmed by checkbox_with_text and a typed name")] }),
  // credit.authorize → 20.3 captureConsent{credit_authorization}: `credit.authorization.captured{kind}`; L2 for a soft pull, L3 for a hard pull —
  // 32.14 DELTA-13 / 20.3 rule 2: a soft pull at L1 when the API states `consumer_entered_identity: true` (the consumer's own entry or confirmation of name, address, DOB and SSN on the application_borrowers row; never the client's claim)
  cmd("credit.authorize", "act", async (i, ctx, rt) => {
    need(i, "kind", "lead_id", "text_hash"); const kind = str(i, "kind"); const authorization_id = str(i, "authorization_id") || randomUUID(); const entered = i.consumer_entered_identity === true;
    const r = await delegate(rt, ctx, "20.3", "captureConsent", { lead_id: str(i, "lead_id"), kind: "credit_authorization", authorization_id, authorization_kind: kind === "hard_pull" ? "hard_application" : "soft_prequal", party_id: str(i, "party_id") || null, text_version: str(i, "text_hash"), channel: "web_chat", end_user: "partner", ...(entered ? { consumer_entered_identity: true } : {}), evidence: { signature: str(i, "signature") || null, card_instance_id: cardId(i), ip: str(i, "ip") || null, ...(entered ? { consumer_entered_identity: true } : {}) } }) as Record<string, unknown>;
    ctx.events.append({ type: "credit.authorization.captured", actor: ctx.actor, payload: { kind, authorization_id, lead_id: str(i, "lead_id"), party_id: str(i, "party_id") || null, text_hash: str(i, "text_hash"), card_instance_id: cardId(i), consumer_entered_identity: entered, assurance_level: str(i, "assurance_level") || null } });
    const pulled = kind === "soft_pull" && i.order_pull !== false ? await delegate(rt, ctx, "20.3", "orderSoftPull", { lead_id: str(i, "lead_id"), requested_by: "consumer" }) as Record<string, unknown> : null;
    return ok("credit.authorize", { kind, authorization_id, permissible_purpose: r["permissible_purpose"], soft_pull_requested: !!pulled, consumer_entered_identity: entered });
  }, { guardrails: [never("LEVEL_REQUIRED", "02 §2 credit.authorize: L2 (soft) / L3 (hard); 32.14 DELTA-13 / 20.3 rule 2: L1 for a soft pull with the consumer's own entry of name, address, DOB and SSN (`consumer_entered_identity`, stated by the API)", (i) => str(i, "kind") === "hard_pull" ? !levelAtLeast(i, "L3") : !(levelAtLeast(i, "L2") || (i.consumer_entered_identity === true && levelAtLeast(i, "L1"))), "a soft pull needs an L2 session (or L1 with the consumer's own identity entry) and a hard pull an L3 session"),
    never("CREDIT_AUTHORIZATION_KIND", "02 §2: kind ∈ {soft_pull, hard_pull}", (i) => str(i, "kind") !== "" && !["soft_pull", "hard_pull"].includes(str(i, "kind")), "kind must be soft_pull or hard_pull"),
    never("SM_O21_JOINT_INTENT_GATE", "21.1 rule 4 / §1002.7(d)(1) — 32.5 §7: joint intent is affirmed by each borrower before their credit is ordered (the API states `joint_intent_required` / `joint_intent_affirmed` from 21.1's own record)", (i) => i.joint_intent_required === true && i.joint_intent_affirmed !== true, "this borrower has not affirmed joint intent — the ConsentCard{joint_intent} comes first")] }),
  // application.confirmField → 21.1 confirmPrefill (a six-item prefill) / captureField (any other path): the O2.1 rule-1 event
  cmd("application.confirmField", "write", async (i, ctx, rt) => {
    const application_id = needApp(i, ctx); need(i, "path"); const path = str(i, "path"); const item = path.replace(/^application\./, "");
    // 32.5 §2.4 — the pre-closing credit refresh's ConfirmCard: `credit.alert.<alert_id>` is 22.2's own triage, never an intake field. Yes → `verified_new_debt`
    // (the liability row, 22.5's DTI recalculation, 23.1's B3-2-10 tolerance test → `du.resubmission.required|waived`); no → 22.2's explained/dispute path (SQ-14/15).
    if (item.startsWith("credit.alert.")) {
      const alert_id = item.slice("credit.alert.".length); const v = obj(i, "value");
      const yes = v["is_mine"] === true || v["is_mine"] === "yes" || str(i, "option_id") === "yes";
      const alert = rt.store.get("credit_alerts", alert_id)?.data as Record<string, unknown> | undefined; if (!alert) throw new RangeError(`no credit_alerts row ${alert_id}`);
      const payload = (alert["payload"] as Record<string, unknown> | undefined) ?? {}; const creditor = String(v["creditor_name"] ?? payload["creditor_name"] ?? "the creditor");
      if (!yes) {
        const t = await delegate(rt, ctx, "22.2", "triageUdmAlert", { application_id, alert_id, status: "explained", rationale: `the borrower does not recognize the ${creditor} account (ConfirmCard ${cardId(i) ?? "-"}) — 22.2 dispute path (SQ-15)`, explanation: String(v["explanation"] ?? "not mine") }) as Record<string, unknown>;
        return ok("application.confirmField", { application_id, path, alert_id, is_mine: false, confirmed_at: ctx.now, triage: (t["alert"] as Record<string, unknown> | undefined)?.["status"] ?? "explained", next: "22.2 dispute/fraud path (SQ-14/15)" });
      }
      // the figures the tolerance test measures against are DU's own last submission (never re-typed): qualifying income and total obligations from the ULAD snapshot
      const subs = rt.store.list("du_submissions", (d) => d.application_id === application_id).map((x) => x.data as Record<string, unknown>).sort((a, b) => Number(a["submission_number"] ?? 0) - Number(b["submission_number"] ?? 0));
      const baseline = subs.at(-1); if (!baseline) throw new RangeError("no DU submission to measure the new debt against (23.1)");
      const snap = (baseline["snapshot"] as Record<string, unknown>) ?? {}; const income = cents(snap["qualifying_income_cents"] ?? 0); const obligations = cents(snap["total_obligations_cents"] ?? 0);
      const monthly = cents(v["monthly_payment_cents"] ?? payload["monthly_payment_cents"] ?? 0); if (monthly <= 0n) throw new RangeError("monthly_payment_cents is required to add the debt");
      const t = await delegate(rt, ctx, "22.2", "triageUdmAlert", { application_id, alert_id, status: "verified_new_debt", rationale: `the borrower confirmed the ${creditor} account through the ConfirmCard ${cardId(i) ?? "-"}`, explanation: String(v["explanation"] ?? `${creditor} account confirmed by the borrower`), evidence_document_id: cardId(i), creditor_name: creditor, liability_kind: String(v["liability_kind"] ?? payload["liability_kind"] ?? "installment"), monthly_payment_cents: monthly, balance_cents: cents(v["balance_cents"] ?? payload["balance_cents"] ?? 0), qualifying_income_cents: income, obligations_cents: obligations }) as Record<string, unknown>;
      const impact = t["impact"] as Record<string, unknown> | null;
      let resubmission: Record<string, unknown> | null = null;
      if (impact) {
        const candidate = { ...snap, total_obligations_cents: (obligations + monthly).toString() };
        const r23 = await delegate(rt, ctx, "23.1", "evaluateResubmission", { application_id, casefile_id: baseline["casefile_id"], baseline, candidate, trigger_event: "credit.undisclosed_debt.found", credit_report_updated: true }) as Record<string, unknown>;
        resubmission = { result: r23["result"], rule_codes: r23["rule_codes"], reason: r23["reason"], event: r23["event"] };
      }
      return ok("application.confirmField", { application_id, path, alert_id, is_mine: true, confirmed_at: ctx.now, liability: impact ? (impact["liability"] as Record<string, unknown>)["liability_id"] : null, dti_after_tenths: impact?.["new_dti_tenths"] ?? null, tolerance: impact?.["tolerance"] ?? null, resubmission });
    }
    if (list(i, "fields").length) return confirmFields(i, ctx, rt, application_id, item);   // 32.3: a multi-field card resolve (the API settles each field's source)
    const r = SIX_ITEMS.has(item)
      ? await delegate(rt, ctx, "21.1", "confirmPrefill", { application_id, item, ...(i.value !== undefined ? { value: i.value } : {}), borrower_id: str(i, "borrower_id") || undefined, confirmed: true }) as Record<string, unknown>
      : await delegate(rt, ctx, "21.1", "captureField", { application_id, field: item, value: i.value, borrower_id: str(i, "borrower_id") || undefined }) as Record<string, unknown>;
    if (str(i, "application_borrower_id") && str(i, "source")) { const abId = str(i, "application_borrower_id"); const now = ctx.now; const src = str(i, "source"); const value = i.value;
      defer(rt, async (q) => { await q.query(`UPDATE application_borrowers SET prefill = jsonb_set(prefill, ARRAY[$2], coalesce(prefill->$2, '{}'::jsonb) || $3::jsonb) WHERE id = $1`, [abId, item, toJson({ value, source: src, confirmed_at: now })]); }); }
    return ok("application.confirmField", { application_id, path, source: str(i, "source") || null, confirmed_at: ctx.now, six_items_complete: r["six_items_complete"] ?? null, trid_emitted: r["trid_emitted"] ?? false });
  }),
  // application.setGoal → 21.1 startInterview (first touch) + captureField{credit_request}: `application.started` is the runtime's own (POST /v1/applications); the Reg B receipt here
  cmd("application.setGoal", "write", async (i, ctx, rt) => {
    const application_id = needApp(i, ctx); need(i, "transaction_type", "occupancy");
    const intake = rt.store.get("applications", application_id);
    if (!intake) await delegate(rt, ctx, "21.1", "startInterview", { application_id, session_id: str(i, "session_id") || `card-${cardId(i) ?? randomUUID()}`, partner_name: str(i, "partner_name") || "Supermortgage", partner_nmlsr_id: str(i, "partner_nmlsr_id") || null, intake_channel: "web", channel: "web", creditor_time_zone: str(i, "time_zone") || "America/New_York", property_state: str(i, "property_state") || null, transaction_type: str(i, "transaction_type"), occupancy: str(i, "occupancy"), borrowers: list(i, "borrowers") });
    const property = obj(i, "property");
    const r = await delegate(rt, ctx, "21.1", "captureField", { application_id, field: "credit_request", transaction_type: str(i, "transaction_type"), occupancy: str(i, "occupancy"), property_state: (property["state"] as string | undefined) ?? str(i, "property_state") ?? null, property_address: property["tbd"] === true ? null : ((property["address"] as string | undefined) ?? null) }) as Record<string, unknown>;
    const extras: Record<string, unknown> = {};
    if (i.value_estimate !== undefined && i.value_estimate !== null) extras["value_estimate"] = await delegate(rt, ctx, "21.1", "captureField", { application_id, field: "property_value_estimate", value: String(cents(i.value_estimate)) });
    if (i.loan_amount_sought !== undefined && i.loan_amount_sought !== null) extras["loan_amount_sought"] = await delegate(rt, ctx, "21.1", "captureField", { application_id, field: "loan_amount_sought", value: String(cents(i.loan_amount_sought)) });
    return ok("application.setGoal", { application_id, status: r["status"], application_date: r["application_date"], property_tbd: property["tbd"] === true, ...extras });
  }),
  // application.answerDeclarations → the `declarations` row (all false = "none apply"); 21.1 names no declarations tool (DIRECT_TO_OPS)
  cmd("application.answerDeclarations", "write", (i, ctx, rt) => {
    const application_id = needApp(i, ctx); const declarations = list(i, "declarations");
    if (declarations.length !== 13) throw new RangeError("declarations[13] is required (URLA Section 5; all false = none apply)");
    const borrower_id = str(i, "borrower_id") || "all"; const id = `${application_id}:${borrower_id}`;
    const rec = rt.store.put("declarations", id, { application_id, borrower_id, declarations: declarations.map((d) => d === true), none_apply: declarations.every((d) => d !== true), answered_at: ctx.now, card_instance_id: cardId(i) }, ctx.actor, ctx.now);
    ctx.events.append({ type: "application.declarations.answered", applicationId: application_id, aggregate: { kind: "declarations", id }, actor: ctx.actor, payload: { application_id, borrower_id, none_apply: rec.data["none_apply"], version: rec.version } });
    return ok("application.answerDeclarations", { application_id, borrower_id, none_apply: rec.data["none_apply"] });
  }),
  // application.answerDemographics → 21.1 askDemographics{collection_method=internet}; own party only; values never echoed
  cmd("application.answerDemographics", "write", async (i, ctx, rt) => {
    const application_id = needApp(i, ctx); need(i, "borrower_id");
    const declined = flag(i, "declined");
    await delegate(rt, ctx, "21.1", "askDemographics", { application_id, borrower_id: str(i, "borrower_id"), collection_method: str(i, "collection_method") || "internet", ethnicity: declined ? null : (i.ethnicity ?? null), race: declined ? null : (i.race ?? null), sex: declined ? null : (i.sex ?? null), declined_ethnicity: declined || flag(i, "declined_ethnicity"), declined_race: declined || flag(i, "declined_race"), declined_sex: declined || flag(i, "declined_sex") });
    return ok("application.answerDemographics", { application_id, borrower_id: str(i, "borrower_id"), collection_method: str(i, "collection_method") || "internet", answered_at: ctx.now });   // never the values (01 §3.19)
  }, { guardrails: [guard("NO_DEMOGRAPHIC_AT_LEAD", "20.3 rule 6 / T12; 32.3 T15: the §1002.13 request exists only once the application is started (21.1)", (_i, ctx) => (hasEvent(ctx, /^application\.(started|received|trid_received)$/) ? undefined : "the demographic questions are asked at application, never at the lead stage")),
    never("DEMOGRAPHICS_OWN_PARTY_ONLY", "02 §2 / 01 §3.19: own party only — never inferred, never answered for another borrower", (i) => str(i, "own_borrower_id") !== "" && str(i, "own_borrower_id") !== str(i, "borrower_id"), "a party answers the demographic questions only for themself"),
    never("DEMOGRAPHICS_NOT_IN_PERSON", "DELTA-09 / 21.1 rule 3: `video` is not in person; the card's collection_method is internet or telephone", (i) => str(i, "collection_method") !== "" && !["internet", "telephone"].includes(str(i, "collection_method")), "collection_method must be internet or telephone from the card")] }),
  // application.affirmJointIntent → 21.1 affirmJointIntent{method=card_affirmation, evidence_id=card_instance_id}; before that party's credit order (SM_O21_JOINT_INTENT_GATE)
  cmd("application.affirmJointIntent", "write", async (i, ctx, rt) => {
    const application_id = needApp(i, ctx); need(i, "borrower_id");
    const r = await delegate(rt, ctx, "21.1", "affirmJointIntent", { application_id, borrower_id: str(i, "borrower_id"), method: "web_checkbox", evidence_id: cardId(i) || str(i, "evidence_id") || randomUUID() }) as Record<string, unknown>;   // MISMO 3.4 B324 joint_intent_method: the ConsentCard's checkbox
    return ok("application.affirmJointIntent", { application_id, borrower_id: str(i, "borrower_id"), affirmed_at: r["affirmed_at"] ?? ctx.now });
  }, { guardrails: [never("JOINT_INTENT_OWN_PARTY_ONLY", "01 §3.5 / 02 §2: joint intent is each borrower's own affirmation — never inferred from the other borrower", (i) => str(i, "own_borrower_id") !== "" && str(i, "own_borrower_id") !== str(i, "borrower_id"), "a party affirms joint intent only for themself"),
    never("SM_O21_JOINT_INTENT_GATE", "21.1 rule 4 / §1002.7(d): joint intent is affirmed by each borrower before their credit is ordered", (i) => flag(i, "credit_already_ordered"), "credit was already ordered for this borrower — intent must precede the order")] }),
  // application.inviteParty → the party + its conversation (DIRECT_TO_OPS): `application.party.invited`; the inviter never answers for the invitee
  cmd("application.inviteParty", "write", (i, ctx, rt) => {
    const application_id = needApp(i, ctx); const contact = obj(i, "contact"); const role = str(i, "role") || str(i, "party_role"); if (!role) throw new RangeError("role is required");   // the InviteCard's evidence names `party_role` (01 §3.13)
    if (!["co_borrower", "non_borrowing_spouse", "poa", "authorized_third_party"].includes(role)) throw new RangeError("role must be co_borrower, non_borrowing_spouse, poa or authorized_third_party");
    if (!contact["email"] && !contact["phone"]) throw new RangeError("contact.email or contact.phone is required");
    const legal_name = str(i, "legal_name") || String(contact["name"] ?? "") || [contact["first_name"], contact["last_name"]].filter((x) => typeof x === "string" && x).join(" ") || "Invited party"; const ab_id = randomUUID(); const party_id = randomUUID(); const now = ctx.now;
    defer(rt, async (q) => {
      await q.query(`INSERT INTO parties (id, party_type, legal_name, contact) VALUES ($1, 'borrower', $2, $3::jsonb)`, [party_id, legal_name, toJson(contact)]);
      if (role === "co_borrower" || role === "non_borrowing_spouse") await q.query(`INSERT INTO application_borrowers (id, application_id, borrower_role, legal_name, contact, party_id, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`, [ab_id, application_id, role, legal_name, toJson(contact), party_id, now]);
      await q.query(`INSERT INTO conversations (party_id, retention_class) VALUES ($1, 'fnma_loan_file_life_plus_4y') ON CONFLICT (party_id) DO NOTHING`, [party_id]);
    });
    ctx.events.append({ type: "application.party.invited", applicationId: application_id, actor: ctx.actor, payload: { application_id, party_id, application_borrower_id: role === "co_borrower" || role === "non_borrowing_spouse" ? ab_id : null, role, invited_by_party_id: str(i, "party_id") || null, card_instance_id: cardId(i), contact_channels: Object.keys(contact).filter((k) => k === "email" || k === "phone") } });
    return ok("application.inviteParty", { application_id, party_id, application_borrower_id: role === "co_borrower" || role === "non_borrowing_spouse" ? ab_id : null, role, waiting_on: legal_name });
  }),
  // verification.connect → 22.3 orderVerificationReport (truv_income) / 22.4 orderAssetReport (plaid_assets) / 22.3 tax transcript (irs_ives) / 24.5 requestEvidence (carrier_connect); post-intent or fee_paid_by=sm
  cmd("verification.connect", "act", async (i, ctx, rt) => {
    const application_id = needApp(i, ctx); need(i, "vendor", "borrower_id"); const vendor = str(i, "vendor"); const consent = str(i, "authorization_consent_id") || cardId(i) || ""; if (!consent) throw new RangeError("authorization_consent_id is required (the ConnectCard or the standing authorization consent)");
    let r: Record<string, unknown>;
    if (vendor === "truv_income") r = await delegate(rt, ctx, "22.3", "orderVerificationReport", { application_id, op: "order", borrower_id: str(i, "borrower_id"), component: str(i, "component") || "income", supplier_code: "TRUV", report_type: "voie", authorization_consent_id: consent }) as Record<string, unknown>;
    else if (vendor === "irs_ives") r = await delegate(rt, ctx, "22.3", "orderVerificationReport", { application_id, op: "order", borrower_id: str(i, "borrower_id"), component: "tax_transcript", supplier_code: "IRS_IVES", report_type: "tax_transcript", authorization_consent_id: consent }) as Record<string, unknown>;
    else if (vendor === "plaid_assets") r = await delegate(rt, ctx, "22.4", "orderAssetReport", { application_id, borrower_id: str(i, "borrower_id"), authorization_consent_id: consent, supplier_code: "PLAID", ...(i.report_days !== undefined ? { report_days: i.report_days } : {}) }) as Record<string, unknown>;
    else if (vendor === "carrier_connect") r = await delegate(rt, ctx, "24.5", "requestEvidence", { application_id, kinds: ["hoi_declaration"], to: "borrower_agent", channel: "portal" }) as Record<string, unknown>;
    else throw new RangeError("vendor must be truv_income, plaid_assets, irs_ives or carrier_connect");
    ctx.events.append({ type: "verification.connector.started", applicationId: application_id, actor: ctx.actor, payload: { vendor: `FAKE:${vendor}`, borrower_id: str(i, "borrower_id"), card_instance_id: cardId(i), order_id: r["order_id"] ?? r["verification_id"] ?? null } });
    return ok("verification.connect", { application_id, vendor, vendor_fake: "FAKE", order_id: r["order_id"] ?? r["verification_id"] ?? null, state: "in_progress" });
  }, { guardrails: [guard("REGZ_1026_19E2_INTENT_FEE_GATE", "01 §3.4 / 02 §2: a Truv or Plaid connection only after intent.to_proceed.received or with fee_paid_by=sm", (i, ctx) => (["truv_income", "plaid_assets"].includes(str(i, "vendor")) && str(i, "fee_paid_by") !== "sm" && !hasEvent(ctx, "intent.to_proceed.received") ? "no intent to proceed yet and the connection is not SM-paid" : undefined))] }),
  // document.upload → 22.1 ingestDocument{source_channel=borrower_upload}: `document.received` → `document.classified`
  cmd("document.upload", "write", async (i, ctx, rt) => {
    const application_id = needApp(i, ctx); need(i, "document_id", "sha256");
    // 32.5 §2.2: an UploadCard names the 22.1 request it answers (`request_id`) — `document.received{request_id}` satisfies SM_NEEDS_LIST_BORROWER_RESPONSE_5
    const r = await delegate(rt, ctx, "22.1", "ingestDocument", { application_id, document_id: str(i, "document_id"), source_channel: "borrower_upload", sha256: str(i, "sha256"), page_count: Number(i.page_count ?? 0), declared_class: str(i, "document_class") || null, subject_borrower_id: str(i, "borrower_id") || null, ...(str(i, "request_id") ? { request_id: str(i, "request_id") } : {}), ...(list(i, "applicant_borrower_ids").length ? { applicant_borrower_ids: i.applicant_borrower_ids } : {}), sender_identity: { party_id: str(i, "party_id") || null, card_instance_id: cardId(i) }, received_at: ctx.now }) as Record<string, unknown>;
    return ok("document.upload", { application_id, document_id: str(i, "document_id"), status: r["status"], quarantined: r["quarantined"] ?? false, matched_request_ids: r["matched_request_ids"] ?? [] });
  }),
  // explanation.submit → the signed letter document (explanation_letter / inquiry_explanation) + 22.1 ingestDocument
  cmd("explanation.submit", "write", async (i, ctx, rt) => {
    const application_id = needApp(i, ctx); need(i, "subject_ref", "text", "attestation"); const text = str(i, "text");
    const doc_class = str(i, "document_class") === "inquiry_explanation" || /inquiry/i.test(str(i, "subject_ref")) ? "inquiry_explanation" : "explanation_letter";
    const document_id = randomUUID(); const digest = sha(`${str(i, "subject_ref")}\n${text}\n${str(i, "attestation")}`); const now = ctx.now; const party_id = str(i, "party_id") || null; const borrower_id = str(i, "borrower_id") || null;
    const abRow = isUuid(str(i, "application_borrower_id")) ? str(i, "application_borrower_id") : isUuid(borrower_id) ? borrower_id : null;   // documents.subject_borrower_id is the application_borrowers uuid; 22.1's subject_borrower_id is the interview's own id
    defer(rt, async (q) => { await q.query(`INSERT INTO documents (id, kind, sha256, byte_size, storage_uri, mime_type, application_id, doc_class, source_channel, sender_identity, received_at, subject_borrower_id, page_count, metadata) VALUES ($1, 'origination_document', $2, $3, $4, 'text/plain', $5, $6, 'borrower_upload', $7::jsonb, $8, $9, 1, $10::jsonb)`,
      [document_id, digest, Buffer.byteLength(text), `letter://${document_id}`, application_id, doc_class, toJson({ party_id, card_instance_id: cardId(i) }), now, abRow, toJson({ subject_ref: str(i, "subject_ref"), attestation: str(i, "attestation"), text_hash: digest, typed_name: str(i, "typed_name") || null, title: doc_class === "inquiry_explanation" ? "Inquiry explanation" : "Letter of explanation" })]); });
    const r = await delegate(rt, ctx, "22.1", "ingestDocument", { application_id, document_id, source_channel: "borrower_upload", sha256: digest, page_count: 1, declared_class: doc_class, subject_borrower_id: borrower_id, sender_identity: { party_id, card_instance_id: cardId(i) }, received_at: now }) as Record<string, unknown>;
    return ok("explanation.submit", { application_id, document_id, doc_class, text_hash: digest, status: r["status"] });
  }),
  // disclosure.acknowledgeReceipt → 25.2 recordReceipt (a CD) / `disclosure.le.received{esign_confirmed}` (an LE); needs consents{esign, active} for the class
  cmd("disclosure.acknowledgeReceipt", "act", async (i, ctx, rt) => {
    const application_id = needApp(i, ctx); need(i, "disclosure_id", "consumer_id"); const disclosure_id = str(i, "disclosure_id");
    const row = rt.store.get("disclosures", disclosure_id)?.data as Record<string, unknown> | undefined;
    const kind = str(i, "kind") || (row?.["kind"] as string | undefined) || (/^CD/i.test(disclosure_id) ? "cd" : "le");
    if (kind === "cd") {
      const r = await delegate(rt, ctx, "25.2", "recordReceipt", { application_id, disclosure_id, consumer_id: str(i, "consumer_id"), evidence: "esign_confirmed", at: ctx.now, evidence_document_id: cardId(i) || str(i, "evidence_document_id") || `card-${randomUUID()}` }) as Record<string, unknown>;
      return ok("disclosure.acknowledgeReceipt", { application_id, disclosure_id, kind, receipt: r["receipt"] ?? r, received_at: ctx.now });
    }
    if (kind === "flood_notice") {   // 32.6 §5: the flood notice's acknowledgment is 24.5's own act (`flood.notice.acknowledged`), never a disclosure row
      const r = await delegate(rt, ctx, "24.5", "deliverNotice", { application_id, op: "acknowledge", acknowledged_at: ctx.now, method: str(i, "method") || "esign", before_signing: true, ...(str(i, "short_period_reason") ? { short_period_reason: str(i, "short_period_reason") } : {}) }) as Record<string, unknown>;
      return ok("disclosure.acknowledgeReceipt", { application_id, disclosure_id, kind, received_at: ctx.now, effective_receipt_date: r["effective_receipt_date"] ?? null, acknowledged_at: r["acknowledged_at"] ?? ctx.now });
    }
    const received_on = ctx.now.slice(0, 10);
    ctx.events.append({ type: `disclosure.${kind}.received`, applicationId: application_id, aggregate: { kind: "disclosure", id: disclosure_id }, actor: ctx.actor, payload: { application_id, disclosure_id, borrower_id: str(i, "consumer_id"), evidence: "esign_confirmed", receipt_evidence: "esign_confirmed", evidence_kind: "portal_acknowledgement", received_on, received_at: ctx.now, effective_receipt_date: received_on, card_instance_id: cardId(i) } });
    if (row) rt.store.put("disclosures", disclosure_id, { ...row, status: "received", effective_receipt_date: (row["effective_receipt_date"] as string | undefined) ?? received_on, receipt_evidence: "esign_confirmed", received_at: ctx.now }, ctx.actor, ctx.now);
    return ok("disclosure.acknowledgeReceipt", { application_id, disclosure_id, kind, received_at: ctx.now, effective_receipt_date: received_on });
  }, { guardrails: [never("ESIGN_7001C_CONSENT_GATE", "01 §3.6 / 02 §2: receipt through the card only under consents{kind=esign, status=active} for the class", (i) => i.esign_consent_active !== undefined && i.esign_consent_active !== true, "no active E-SIGN consent for this document class — the document is mailed instead")] }),
  // intent.record → 21.4 recordIntent{channel=app_button}: `intent.to_proceed.received`; opens REGZ_1026_19E2_INTENT_FEE_GATE
  cmd("intent.record", "write", async (i, ctx, rt) => {
    const application_id = needApp(i, ctx);
    const r = await delegate(rt, ctx, "21.4", "recordIntent", { application_id, channel: "app_button", statement_text: str(i, "statement_text") || "I want to proceed with this Loan Estimate", evidence_document_id: cardId(i) || str(i, "evidence_document_id") || `card-${randomUUID()}`, received_at: ctx.now, ...(str(i, "disclosure_id") ? { disclosure_id: str(i, "disclosure_id") } : {}) }) as Record<string, unknown>;
    return ok("intent.record", { application_id, intent_id: r["intent_id"], valid: r["valid"], le_effective_receipt_date: r["le_effective_receipt_date"], received_at: ctx.now });
  }),
  // lock.request → 21.4 requestLock (SM_O61_COMPLIANCE_PASS_LOCK_GATE, SM_QUOTE_VALIDITY_GATE inside): `lock.requested` → pending_mlo_approval
  cmd("lock.request", "write", async (i, ctx, rt) => {
    const application_id = needApp(i, ctx); need(i, "quote_id", "property_state", "le_loan_amount_cents");
    const r = await delegate(rt, ctx, "21.4", "requestLock", { application_id, quote_id: str(i, "quote_id"), borrower_statement: str(i, "borrower_statement") || "Please lock my rate", property_state: str(i, "property_state"), le_loan_amount_cents: cents(i.le_loan_amount_cents), requested_at: ctx.now, ...(i.period_days !== undefined ? { lock_period_days: Number(i.period_days) } : {}), float_down_elected: flag(i, "float_down_elected"), ...(str(i, "time_zone") ? { time_zone: str(i, "time_zone") } : {}) }) as Record<string, unknown>;
    return ok("lock.request", { application_id, lock_id: r["lock_id"], status: r["status"], quote_id: str(i, "quote_id"), period_days: i.period_days ?? null, float_down_elected: flag(i, "float_down_elected") });
  }, { guardrails: [guard("REGZ_1026_19E2_INTENT_FEE_GATE", "21.4 rule 1 / 32.3 R11 (T24): a lock follows the LE receipt and a valid intent to proceed — never before", (_i, ctx) => (hasEvent(ctx, "intent.to_proceed.received", (p) => p["valid"] !== false) ? undefined : "no valid intent to proceed on file — the Proceed step comes after the Loan Estimate is received"))] }),
  // lock.requestExtension → 21.4 extendLock{delay_attribution=borrower}: `lock.extended`; locks.status executed|confirmed
  cmd("lock.requestExtension", "write", async (i, ctx, rt) => {
    const application_id = needApp(i, ctx); need(i, "lock_id", "new_closing_on");
    const r = await delegate(rt, ctx, "21.4", "extendLock", { application_id, lock_id: str(i, "lock_id"), new_closing_on: str(i, "new_closing_on"), delay_attribution: str(i, "delay_attribution") || "borrower", requested_at: ctx.now, ...(str(i, "cd_provided_at") ? { cd_provided_at: str(i, "cd_provided_at") } : {}) }) as Record<string, unknown>;
    return ok("lock.requestExtension", { application_id, lock_id: str(i, "lock_id"), days: r["days"], fee_cents: r["fee_cents"], payer: r["payer"], new_expires_on: r["new_expires_on"] });
  }, { guardrails: [guard("LOCK_NOT_ACTIVE", "02 §2 lock.requestExtension: locks.status = confirmed (an executed lock)", (i, _c) => (i.lock_status !== undefined && !["confirmed", "executed"].includes(String(i.lock_status)) ? `the lock is ${String(i.lock_status)}, not executed/confirmed` : undefined))] }),
  // counteroffer.respond → accept: 21.6 writeDecision{counteroffer_accept}; decline: `counteroffer.declined` (the underwriter's adverse path follows); REGB_1002_9_COUNTEROFFER_90 running
  cmd("counteroffer.respond", "act", async (i, ctx, rt) => {
    const application_id = needApp(i, ctx); need(i, "decision", "decision_id"); const decision = str(i, "decision");
    if (decision === "accept") { const r = await delegate(rt, ctx, "21.6", "writeDecision", { application_id, op: "counteroffer_accept", decision_id: str(i, "decision_id"), method: "card_affirmation", at: ctx.now }) as Record<string, unknown>; return ok("counteroffer.respond", { application_id, decision, disposition: r["disposition"], accepted_at: ctx.now }); }
    if (decision !== "decline") throw new RangeError("decision must be accept or decline");
    ctx.events.append({ type: "counteroffer.declined", applicationId: application_id, actor: ctx.actor, payload: { application_id, decision_id: str(i, "decision_id"), declined_at: ctx.now, card_instance_id: cardId(i) } });
    return ok("counteroffer.respond", { application_id, decision, declined_at: ctx.now, next: "adverse_action_notice (21.6)" });
  }, { guardrails: [guard("REGB_1002_9_COUNTEROFFER_90", "02 §2: REGB_1002_9_COUNTEROFFER_90 running", (_i, ctx) => (timerRunning(ctx, "REGB_1002_9_COUNTEROFFER_90") || hasEvent(ctx, "decision.issued", (p) => p["kind"] === "counteroffer") ? undefined : "no counteroffer is open on this application"))] }),
  // application.withdraw → 21.6 writeDecision{withdrawal} (express withdrawal → HMDA code 4) or `application.withdrawn` before a decision file exists; any non-terminal state
  cmd("application.withdraw", "act", async (i, ctx, rt) => {
    const application_id = needApp(i, ctx); const statement_text = str(i, "reason") || "I withdraw my application"; const withdrawal_id = randomUUID();
    const file = rt.store.get("application_decisions", application_id);
    if (file) { const r = await delegate(rt, ctx, "21.6", "writeDecision", { application_id, op: "withdrawal", withdrawal_id, statement_text, channel: "portal", at: ctx.now, evidence_document_id: cardId(i) }) as Record<string, unknown>; return ok("application.withdraw", { application_id, withdrawal_id, express: r["express"], received_on: r["received_on"] ?? ctx.now.slice(0, 10) }); }
    ctx.events.append({ type: "application.withdrawn", applicationId: application_id, actor: ctx.actor, payload: { application_id, withdrawal_id, statement_text, channel: "portal", express: true, received_at: ctx.now, card_instance_id: cardId(i) } });
    return ok("application.withdraw", { application_id, withdrawal_id, express: true, received_on: ctx.now.slice(0, 10) });
  }, { guardrails: [guard("APPLICATION_TERMINAL", "02 §2 application.withdraw: any non-terminal state", (_i, ctx) => (hasEvent(ctx, /^(application\.withdrawn|loan\.funded|loan\.boarded)$/) ? "the application is already withdrawn or funded" : undefined))] }),
  // mi.selectPlan → 24.6 recordPlanElection{plan}: `plan_selected` (an LE revision follows); mi_certificates.status = quoted
  cmd("mi.selectPlan", "act", async (i, ctx, rt) => {
    const application_id = needApp(i, ctx); need(i, "plan", "quote_id");
    const plan = str(i, "plan"); if (!["bpmi_monthly", "single", "split", "lpmi"].includes(plan)) throw new RangeError("plan must be bpmi_monthly, single, split or lpmi");
    const r = await delegate(rt, ctx, "24.6", "recordPlanElection", { application_id, op: "elect", quote_id: str(i, "quote_id"), plan, premium_plan: plan, units: i.units ?? 1, occupancy: str(i, "occupancy") || "primary", ...Object.fromEntries(Object.entries(i).filter(([k]) => ["loan_amount_cents", "sales_price_cents", "appraised_value_cents", "transaction_type", "product", "term_months", "coverage_option", "ltv"].includes(k))), elected_at: ctx.now, evidence_document_id: cardId(i) }) as Record<string, unknown>;
    return ok("mi.selectPlan", { application_id, plan, quote_id: str(i, "quote_id"), status: r["status"] ?? "plan_selected" });
  }, { guardrails: [guard("MI_QUOTE_NOT_READY", "02 §2 mi.selectPlan: mi_certificates.status = quoted", (i, _c) => (i.certificate_status !== undefined && String(i.certificate_status) !== "quoted" ? `the MI certificate is ${String(i.certificate_status)}, not quoted` : undefined))] }),
  // valuation.scheduleAccess → 24.1 scheduleInspection{scheduled_for=slot}: `inspection_scheduled`; valuation_orders.status = assigned
  cmd("valuation.scheduleAccess", "write", async (i, ctx, rt) => {
    const application_id = needApp(i, ctx); need(i, "order_id", "slot");
    const r = await delegate(rt, ctx, "24.1", "scheduleInspection", { application_id, order_id: str(i, "order_id"), scheduled_for: str(i, "slot"), scheduled_at: ctx.now }) as Record<string, unknown>;
    return ok("valuation.scheduleAccess", { application_id, order_id: str(i, "order_id"), slot: str(i, "slot"), status: r["status"] });
  }, { guardrails: [guard("VALUATION_NOT_ASSIGNED", "02 §2 valuation.scheduleAccess: valuation_orders.status = assigned", (i, _c, ) => (i.order_status !== undefined && String(i.order_status) !== "assigned" ? `the order is ${String(i.order_status)}, not assigned` : undefined))] }),
  // rov.request → 24.2 screenRov{requested_by=borrower}: `rov.requested`; appraisals.review_status = accepted, before FNMA_B4_1_3_12_ROV_CLOSING_GATE
  cmd("rov.request", "act", async (i, ctx, rt) => {
    const application_id = needApp(i, ctx); need(i, "appraisal_id", "narrative");
    const rov_id = str(i, "rov_id") || randomUUID();
    const r = await delegate(rt, ctx, "24.2", "screenRov", { application_id, request: { rov_id, appraisal_id: str(i, "appraisal_id"), requested_by: "borrower", requested_at: ctx.now, narrative: str(i, "narrative"), comparables: list(i, "comparables"), borrower_names: list(i, "borrower_names").map(String), property_address: str(i, "property_address"), appraisal_effective_date: str(i, "appraisal_effective_date") || ctx.now.slice(0, 10), appraiser_name: str(i, "appraiser_name"), disputed_areas: list(i, "disputed_areas").length ? list(i, "disputed_areas").map(String) : [str(i, "narrative")], additional_information: obj(i, "additional_information"), card_instance_id: cardId(i) } }) as Record<string, unknown>;
    return ok("rov.request", { application_id, rov_id, appraisal_id: str(i, "appraisal_id"), screen: r["screen"] ?? r });
  }, { guardrails: [guard("FNMA_B4_1_3_12_ROV_CLOSING_GATE", "02 §2 rov.request: before FNMA_B4_1_3_12_ROV_CLOSING_GATE (consummation)", (_i, ctx) => (hasEvent(ctx, "closing.consummated") ? "the loan has consummated — a reconsideration of value is no longer available" : undefined)),
    guard("APPRAISAL_NOT_ACCEPTED", "02 §2 rov.request: appraisals.review_status = accepted", (i) => (i.review_status !== undefined && String(i.review_status) !== "accepted" ? `the appraisal review is ${String(i.review_status)}, not accepted` : undefined))] }),
  // insurance.submitEvidence → 24.5 extractEvidence{kind=hoi_declaration}: `insurance.evidence.received`
  cmd("insurance.submitEvidence", "write", async (i, ctx, rt) => {
    // 32.9 §1 (servicing, 9.5): evidence of the borrower's own coverage on a serviced loan with an FPI case — `insurance.evidence.received{fpi_active}` on the loan (the anchor of
    // REGX_1024_37G_FPI_CANCEL_REFUND_15) and 9.5's evaluation; the origination path (24.5) below stays for an application's hazard requirement
    if (loanOf(i, ctx) && (flag(i, "servicing") || str(i, "fpi_case_id"))) {
      const loan_id = loanOf(i, ctx); need(i, "document_id"); const kind = str(i, "kind") === "flood" ? "flood" : "hazard"; const evidence_id = str(i, "evidence_id") || `ev-${loan_id.slice(0, 8)}-${randomUUID().slice(0, 8)}`; const received_on = ctx.now.slice(0, 10);
      ctx.events.append({ type: "insurance.evidence.received", loanId: loan_id, actor: ctx.actor, payload: { evidence_id, kind, fpi_active: true, channel: "portal", receipt: received_on, received_at: received_on, document_id: str(i, "document_id"), fpi_case_id: str(i, "fpi_case_id") || null, coverage_effective: str(i, "coverage_effective") || null, coverage_expiration: str(i, "coverage_expiration") || null, policy_number: str(i, "policy_number") || null, carrier: str(i, "carrier") || null, party_id: str(i, "party_id") || null, card_instance_id: cardId(i) } });
      const r = await delegate(rt, ctx, "9.5", "evaluateEvidence", { loan_id, evidence_id, kind, continuous_coverage_shown: i.continuous_coverage_shown === undefined ? true : flag(i, "continuous_coverage_shown"), written: true }) as Record<string, unknown>;
      return ok("insurance.submitEvidence", { loan_id, document_id: str(i, "document_id"), evidence_id, kind, received_on, outcome: r["outcome"], reason: r["reason"] ?? null, servicing: true });
    }
    const application_id = needApp(i, ctx); need(i, "document_id");
    const r = await delegate(rt, ctx, "24.5", "extractEvidence", { application_id, kind: str(i, "kind") || "hoi_declaration", document_id: str(i, "document_id"), received_at: ctx.now, fields: obj(i, "fields"), confidence: obj(i, "confidence"), source: str(i, "carrier_connection_id") ? "carrier_connect_FAKE" : "borrower_upload" }) as Record<string, unknown>;
    return ok("insurance.submitEvidence", { application_id, document_id: str(i, "document_id"), evidence_id: r["evidence_id"], status: r["status"], confirmation_required: r["confirmation_required"] ?? false });
  }),
  // closing.selectSlot → 26.2 runPreSessionChecks{schedule}: `closing.scheduled`; decision sub-status clear_to_close; SM_O72_RON_STATE_AUTH_GATE inside 26.2
  cmd("closing.selectSlot", "act", async (i, ctx, rt) => {
    const application_id = needApp(i, ctx); need(i, "slot", "state", "settlement_agent_party_id", "transaction_type");
    const closing_id = str(i, "closing_id") || `CLS-${application_id.slice(0, 8)}`;
    const r = await delegate(rt, ctx, "26.2", "runPreSessionChecks", { application_id, op: "schedule", closing_id, scheduled_at: str(i, "slot"), time_zone: str(i, "time_zone") || "America/New_York", state: str(i, "state"), county_fips: str(i, "county_fips") || null, transaction_type: str(i, "transaction_type"), dry_state: flag(i, "dry_state"), settlement_agent_party_id: str(i, "settlement_agent_party_id"), notary_party_id: str(i, "notary_party_id") || null, ron_provider_party_id: str(i, "ron_provider_party_id") || null, eligibility: list(i, "eligibility"), signers: list(i, "signers"), closing_type_preference: str(i, "closing_type_preference") || null, borrower_election: str(i, "closing_type_preference") || null }) as Record<string, unknown>;   // 26.2's decision input names the election `borrower_election` (A2-4.1-03: wet when the borrower says paper)
    return ok("closing.selectSlot", { application_id, closing_id, scheduled_at: str(i, "slot"), closing_type: r["closing_type"], note_form: r["note_form"], scheduled_note_date: r["scheduled_note_date"] });
  }, { guardrails: [guard("SM_UW_CTC_GATE", "02 §2 closing.selectSlot: decision sub-status clear_to_close", (_i, ctx) => (hasEvent(ctx, "clear_to_close.issued") ? undefined : "the file is not clear to close yet"))] }),
  // closing.captureEsignConsent → 26.2 verifyEsignConsent (SM_O72_ESIGN_CONSENT_CLOSING_GATE): signing_sessions.consent_captured; never by voice
  cmd("closing.captureEsignConsent", "act", async (i, ctx, rt) => {
    const application_id = needApp(i, ctx); need(i, "closing_id");
    const consent = { consent_id: str(i, "consent_id") || cardId(i) || randomUUID(), kind: "esign", scope: list(i, "scope").length ? i.scope : ["disclosures", "closing_package", "esign_signatures"], granted_at: ctx.now, withdrawn_at: null, hw_sw_statement_version: str(i, "hw_sw_statement_version") || "2026-09", access_demonstrated: i.access_demonstrated !== false, paper_option_disclosed: true, ...obj(i, "consent") };
    const r = await delegate(rt, ctx, "26.2", "verifyEsignConsent", { application_id, closing_id: str(i, "closing_id"), consent }) as Record<string, unknown>;
    ctx.events.append({ type: "closing.consent.captured", applicationId: application_id, actor: ctx.actor, payload: { closing_id: str(i, "closing_id"), consent_id: consent.consent_id, party_id: str(i, "party_id") || null, card_instance_id: cardId(i), open: r["open"] } });
    return ok("closing.captureEsignConsent", { application_id, closing_id: str(i, "closing_id"), consent_id: consent.consent_id, gate_open: r["open"], reason: r["reason"] ?? null });
  }, { guardrails: [NOT_VOICE("the closing E-SIGN consent")] }),
  // rescission.exercise → 25.3 sweepInboundForRescission{record_exercise}: the `rescinded` path (H-8/H-9); rescission running
  cmd("rescission.exercise", "act", async (i, ctx, rt) => {
    const application_id = needApp(i, ctx); need(i, "consumer_id");
    const exercise_id = str(i, "exercise_id") || randomUUID();
    const r = await delegate(rt, ctx, "25.3", "sweepInboundForRescission", { application_id, op: "record_exercise", exercise_id, consumer_id: str(i, "consumer_id"), method: str(i, "method") || "portal", received_at: ctx.now, document_id: cardId(i) || str(i, "document_id") || `card-${randomUUID()}`, written: true, text: str(i, "text") || "I wish to cancel this transaction." }) as Record<string, unknown>;
    return ok("rescission.exercise", { application_id, exercise_id, consumer_id: str(i, "consumer_id"), status: r["status"] ?? r });
  }, { guardrails: [guard("REGZ_1026_23_RESCISSION_3SBD_GATE", "02 §2 rescission.exercise: rescission running", (_i, ctx) => (timerRunning(ctx, "REGZ_1026_23_RESCISSION_3SBD_GATE") || hasEvent(ctx, /^rescission\.period\.started$/) || hasEvent(ctx, "closing.consummated", (p) => p["rescindable"] === true) ? undefined : "no rescission period is running on this application"))] }),
  // autodraft.enroll / change / pause / revoke → 2.3 autodraft.read/write{write}: the `autodraft.enrollment.*` family (a change re-enters at `requested`); Reg E / Nacha elements displayed (2.x rule 1)
  ...(["enroll", "change", "pause", "revoke"] as const).map((verb) => cmd(`autodraft.${verb}`, "write", async (i, ctx, rt) => {
    const loan_id = needLoan(i, ctx); const id = str(i, "enrollment_id") || (verb === "enroll" ? `AD-${loan_id.slice(0, 8)}-${randomUUID().slice(0, 8)}` : ""); if (!id) throw new RangeError("enrollment_id is required");
    const account = obj(i, "account");
    const status = verb === "enroll" || verb === "change" ? "requested" : verb === "pause" ? "paused" : "revoked";
    const data: Record<string, unknown> = { enrollment_id: id, loan_id, status, party_id: str(i, "party_id") || null, ...(verb === "enroll" || verb === "change" ? { amount_rule: str(i, "amount_rule") || "contractual", draft_day: Number(i.draft_day ?? 1), include_fees: flag(i, "include_fees"), account_last4: String(account["last4"] ?? account["account_last4"] ?? "").slice(-4) || null, account_type: (account["type"] as string | undefined) ?? null, routing: String(account["routing"] ?? "").replace(/\D/g, "") || null, channel: "portal", automation_disclosed: true, human_offered: true, elements_displayed: true, ...(i.extra_principal_cents !== undefined ? { extra_principal_cents: cents(i.extra_principal_cents) } : {}), ...(i.fixed_amount_cents !== undefined ? { fixed_amount_cents: cents(i.fixed_amount_cents) } : {}) } : {}), ...(verb === "revoke" ? { revoked_at: ctx.now, revocation_source: "portal" } : {}), ...(verb === "pause" ? { paused_at: ctx.now } : {}), card_instance_id: cardId(i), version_at: ctx.now };
    if (verb === "enroll" || verb === "change") { const d = Number(data["draft_day"]); if (!(d >= 1 && d <= 16)) throw new RangeError("draft_day must be 1–16"); }
    await delegate(rt, ctx, "2.3", "autodraft.read/write", { op: "write", id, loan_id, data });
    ctx.events.append({ type: verb === "revoke" ? "autodraft.enrollment.revoked" : verb === "pause" ? "autodraft.enrollment.paused" : "autodraft.enrollment.requested", loanId: loan_id, aggregate: { kind: "autodraft_enrollment", id }, actor: ctx.actor, payload: { enrollment_id: id, loan_id, verb, status, party_id: str(i, "party_id") || null, draft_day: data["draft_day"] ?? null, amount_rule: data["amount_rule"] ?? null, include_fees: data["include_fees"] ?? null, card_instance_id: cardId(i), copy_due: "SM_AUTODRAFT_COPY_DELIVERY_1BD" } });
    return ok(`autodraft.${verb}`, { loan_id, enrollment_id: id, status, next: verb === "enroll" || verb === "change" ? "authorized → validating → active" : null });
  }, { guardrails: [FRESH_L1, never("REG_E_ELEMENTS_NOT_SHOWN", "2.x rule 1 / 01 §3.5: every Nacha / Reg E element is displayed before the authorization", (i) => (verb === "enroll" || verb === "change") && i.elements_displayed !== undefined && i.elements_displayed !== true, "the Reg E / Nacha authorization elements were not displayed")], moneyFields: ["fixed_amount_cents", "extra_principal_cents"] })),
  // payment.makeOneTime → 2.1 payments.read/write{write, channel=portal}: `payment.receive{channel=portal}` → received → identified → posted; fresh L1
  cmd("payment.makeOneTime", "write", async (i, ctx, rt) => {
    const loan_id = needLoan(i, ctx); need(i, "amount_cents", "date"); const amount = cents(i.amount_cents); if (amount <= 0n) throw new RangeError("amount_cents must be positive");
    const payment_id = str(i, "payment_id") || `PAY-${loan_id.slice(0, 8)}-${randomUUID().slice(0, 8)}`; const account = obj(i, "account");
    await delegate(rt, ctx, "2.1", "payments.read/write", { op: "write", id: payment_id, loan_id, data: { payment_id, loan_id, amount_cents: amount, received_on: str(i, "date"), credited_as_of: str(i, "date"), channel: "portal", designation: str(i, "designation") || "contractual", status: "received", identification_confidence: 1, conforming: true, include_late_charge: flag(i, "include_late_charge"), account_last4: String(account["last4"] ?? "").slice(-4) || null, card_instance_id: cardId(i) } });
    ctx.events.append({ type: "payment.received", loanId: loan_id, aggregate: { kind: "payment", id: payment_id }, actor: ctx.actor, payload: { payment_id, loan_id, amount_cents: amount.toString(), received_on: str(i, "date"), channel: "portal", designation: str(i, "designation") || "contractual", card_instance_id: cardId(i) } });
    return ok("payment.makeOneTime", { loan_id, payment_id, amount_cents: amount.toString(), date: str(i, "date"), status: "received", channel: "portal" });
  }, { guardrails: [FRESH_L1], moneyFields: ["amount_cents", "received_on"] }),
  // payment.extraPrincipal → 2.1 payments.read/write{write, designation=curtailment}: curtailment received → applied
  cmd("payment.extraPrincipal", "write", async (i, ctx, rt) => {
    const loan_id = needLoan(i, ctx); need(i, "amount_cents"); const amount = cents(i.amount_cents); if (amount <= 0n) throw new RangeError("amount_cents must be positive");
    const payment_id = str(i, "payment_id") || `CURT-${loan_id.slice(0, 8)}-${randomUUID().slice(0, 8)}`; const on = str(i, "date") || ctx.now.slice(0, 10);
    await delegate(rt, ctx, "2.1", "payments.read/write", { op: "write", id: payment_id, loan_id, data: { payment_id, loan_id, amount_cents: amount, received_on: on, credited_as_of: on, channel: "portal", designation: "curtailment", status: "received", identification_confidence: 1, conforming: true, card_instance_id: cardId(i) } });
    ctx.events.append({ type: "payment.received", loanId: loan_id, aggregate: { kind: "payment", id: payment_id }, actor: ctx.actor, payload: { payment_id, loan_id, amount_cents: amount.toString(), received_on: on, channel: "portal", designation: "curtailment", card_instance_id: cardId(i) } });
    return ok("payment.extraPrincipal", { loan_id, payment_id, amount_cents: amount.toString(), designation: "curtailment", status: "received" });
  }, { guardrails: [FRESH_L1], moneyFields: ["amount_cents", "received_on"] }),
  // escrow.electShortage → 3.6 recordBorrowerElection{spread_12 | lump_sum}: plan active / paid_lump; analysis statement_sent
  cmd("escrow.electShortage", "write", async (i, ctx, rt) => {
    const loan_id = needLoan(i, ctx); need(i, "option"); const option = str(i, "option"); if (!["spread_12", "lump_sum"].includes(option)) throw new RangeError("option must be spread_12 or lump_sum");
    // the 3.6 tool reads the election from `data` (the generic write shape) — the resolved card is its evidence (3.6 rule 3)
    const election = { election_id: str(i, "election_id") || `EL-${loan_id.slice(0, 8)}-${randomUUID().slice(0, 8)}`, kind: option === "lump_sum" ? "lump_sum" : "spread", months: option === "spread_12" ? 12 : null, evidence_document_id: cardId(i) || str(i, "evidence_document_id") || `card-${randomUUID()}`, ...(str(i, "analysis_id") ? { analysis_id: str(i, "analysis_id") } : {}), recorded_on: ctx.now.slice(0, 10) };
    const r = await delegate(rt, ctx, "3.6", "recordBorrowerElection", { loan_id, data: election }) as Record<string, unknown>;
    // 32.8 §6.2: "→ escrow.electShortage → plan active or paid_lump" — the spread election creates the 3.6 plan (12 installments from the approved analysis; `escrow.repayment_plan.created` + `loan_terms.versioned`); a lump-sum election is recorded and `paid_lump` follows the receipt (3.6 postEscrowLumpSum)
    const plan = option === "spread_12" ? await delegate(rt, ctx, "3.6", "createRepaymentPlan", { loan_id, kind: "shortage", ...(str(i, "analysis_id") ? { analysis_id: str(i, "analysis_id") } : {}), ...(str(i, "start") ? { start: str(i, "start") } : {}) }) as Record<string, unknown> : null;
    return ok("escrow.electShortage", { loan_id, option, election_id: r["election_id"], kind: r["kind"], months: r["months"] ?? null, plan_id: plan?.["id"] ?? null, plan_status: plan?.["status"] ?? null, plan_months: plan?.["months"] ?? null, installment_cents: plan?.["installment_cents"] ?? null, lump_sum_insert: option === "spread_12" ? "not_rendered" : "NTC_SM_ESCROW_VOLUNTARY_LUMPSUM_INSERT" });
  }, { guardrails: [FRESH_L1, guard("ESCROW_STATEMENT_NOT_SENT", "02 §2 escrow.electShortage: analysis statement_sent", (i, ctx) => (i.analysis_status !== undefined ? (["statement_sent", "effective"].includes(String(i.analysis_status)) ? undefined : `the analysis is ${String(i.analysis_status)}, not statement_sent`) : hasEvent(ctx, /^escrow\.(analysis\.(completed|approved)|statement\.(sent|rendered))$/) ? undefined : "no escrow analysis statement has been sent"))] }),
  // escrow.requestWaiver → 3.8 evaluateWaiver (eligibility): escrowed → evaluating
  cmd("escrow.requestWaiver", "act", async (i, ctx, rt) => {
    const loan_id = needLoan(i, ctx);
    ctx.events.append({ type: "escrow.waiver.requested", loanId: loan_id, actor: ctx.actor, payload: { loan_id, requested_at: ctx.now, channel: "portal", card_instance_id: cardId(i) } });
    const request = obj(i, "request"); if (!Object.keys(request).length) return ok("escrow.requestWaiver", { loan_id, status: "evaluating", evaluated: false, next: "3.8 evaluateWaiver with the loan's facts" });
    // the card's request arrives as JSON: the 3.8 WaiverRequest's cents are bigint
    const money = (k: string) => (request[k] !== undefined && request[k] !== null ? { [k]: cents(request[k]) } : {});
    const r = await delegate(rt, ctx, "3.8", "evaluateWaiver", { loan_id, request: { requested_on: ctx.now.slice(0, 10), ...request, ...money("upb_cents"), ...money("original_appraised_value_cents"), ...money("original_property_value_cents") } }) as Record<string, unknown>;
    return ok("escrow.requestWaiver", { loan_id, status: "evaluating", evaluated: true, decision: r });
  }, { guardrails: [guard("REGZ_1026_35B1_HPML_ESCROW_GATE", "32.8 §6.3 / 23.4-T5 / §1026.35(b)(3): an HPML loan stays escrowed five years from consummation — a cancellation request before `consummation_date + 5y` is refused with the escrow-period copy (the 3.8 engine's HPML_LT_5Y)", (i, ctx) => {
    const request = obj(i, "request"); const all = ctx.events.all();
    const determined = all.filter((e) => e.type === "compliance.hpml.determined").at(-1)?.payload as Record<string, unknown> | undefined; const consummated = all.filter((e) => e.type === "closing.consummated").at(-1)?.payload as Record<string, unknown> | undefined; const boarded = all.filter((e) => e.type === "loan.boarded").at(-1)?.payload as Record<string, unknown> | undefined;
    const hpml = request["hpml"] === true || i.hpml === true || determined?.["is_hpml"] === true || consummated?.["is_hpml"] === true;
    const consummation = String(request["consummation_date"] ?? i.consummation_date ?? consummated?.["consummation_on"] ?? boarded?.["consummation_date"] ?? "");
    if (!hpml || !/^\d{4}-\d{2}-\d{2}$/.test(consummation)) return undefined;
    const floor = addYears(D(consummation), 5); const today = ctx.now.slice(0, 10);
    return today < floor ? `higher-priced mortgage loan: the escrow account may not be cancelled before ${floor} (five years from consummation ${consummation}; §1026.35(b)(3), 23.4 hpml_escrow_min_cancel_date)` : undefined; })] }),
  // pmi.requestCancellation → 10.1 pmi.*{request}: `mi.cancel.requested` + the pmi_cancel case; mi_policies active
  cmd("pmi.requestCancellation", "act", async (i, ctx, rt) => {
    const loan_id = needLoan(i, ctx);
    // 32.9 §2: the borrower withdraws the open request (a ChoiceCard tap) — 10.1 pmi.*{withdraw}: the valuation fee is refunded when no order was placed
    if (flag(i, "withdraw")) { const w = await delegate(rt, ctx, "10.1", "pmi.*", { op: "withdraw", loan_id, case_id: str(i, "case_id") || null, requester_party_id: str(i, "party_id") || null, card_instance_id: cardId(i) }) as Record<string, unknown>; return ok("pmi.requestCancellation", { loan_id, case_id: w["case_id"] ?? null, status: w["status"] ?? "withdrawn", withdrawn: true, fee_refund_cents: w["fee_refund_cents"] ?? null, valuation_ordered: w["valuation_ordered"] ?? null }); }
    // 10.1's request channel vocabulary (written/verbal/portal/sii): the app is `portal`, a spoken turn `verbal`; the API-added facts (channel, evidence, subject, assurance level) never reach the owning tool's input
    const requestChannel = str(i, "channel") === "voice" ? "verbal" : "portal";
    const r = await delegate(rt, ctx, "10.1", "pmi.*", { op: "request", loan_id, requester_party_id: str(i, "party_id") || null, requested_at: ctx.now, request: { loan_id, channel: requestChannel, written: requestChannel !== "verbal", received_on: ctx.now.slice(0, 10), card_instance_id: cardId(i), ...obj(i, "request") }, ...Object.fromEntries(Object.entries(i).filter(([k]) => !["op", "loan_id", "request", "card_instance_id", "party_id", "fresh_l1", "channel", "evidence", "subject", "assurance_level", "application_id"].includes(k))), channel: requestChannel }) as Record<string, unknown>;
    return ok("pmi.requestCancellation", { loan_id, case_id: r["case_id"] ?? null, status: r["status"] ?? "received" });
  }, { guardrails: [guard("MI_POLICY_NOT_ACTIVE", "02 §2 pmi.requestCancellation: mi_policies active", (i, _c) => (i.policy_status !== undefined && String(i.policy_status) !== "active" ? `the MI policy is ${String(i.policy_status)}, not active` : undefined))] }),
  // case.open → `communication.inbound.received{channel=app, written=true}` → 10.1 case.*{write}: the Intake Router's case row
  cmd("case.open", "write", async (i, ctx, rt) => {
    const loan_id = needLoan(i, ctx); need(i, "kind"); const kind = str(i, "kind"); if (!CASE_KINDS.has(kind)) throw new RangeError(`kind must be one of ${[...CASE_KINDS].join(", ")}`);
    const case_id = str(i, "case_id") || `CASE-${loan_id.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
    ctx.events.append({ type: "communication.inbound.received", loanId: loan_id, actor: ctx.actor, payload: { loan_id, channel: "app", written: true, kind, text_sha256: sha(str(i, "text")), attachments: list(i, "attachments").length, party_id: str(i, "party_id") || null, card_instance_id: cardId(i), received_at: ctx.now } });
    await delegate(rt, ctx, "10.1", "case.*", { op: "write", id: case_id, loan_id, data: { case_id, loan_id, case_type: kind, status: "received", channel: "app", is_written: true, received_at: ctx.now, receipt_date: ctx.now.slice(0, 10), received_via: "portal", text: str(i, "text"), attachments: list(i, "attachments"), submitted_by_party_id: str(i, "party_id") || null, card_instance_id: cardId(i) } });
    ctx.events.append({ type: "case.opened", loanId: loan_id, aggregate: { kind: "case", id: case_id }, actor: ctx.actor, payload: { case_id, loan_id, case_type: kind, channel: "app", written: true, received_at: ctx.now } });
    return ok("case.open", { loan_id, case_id, kind, status: "received", written: true });
  }),
  // lossmit.requestAssistance → 12.1 lossmit.application.open/update: `lossmit.rfa.received` (hardship text only) / `lossmit.application.received`
  cmd("lossmit.requestAssistance", "write", async (i, ctx, rt) => {
    const loan_id = needLoan(i, ctx); const hasEvaluative = i.income !== undefined || i.expenses !== undefined || list(i, "documents").length > 0 || !!str(i, "hardship_reason") || !!str(i, "qrpc_id");   // 32.10: a stated hardship reason / QRPC id is evaluative information (12.1 `classify`)
    // 32.10 (additive): `op`/`id`/`status` pass through so a ConfirmCard correction updates the same application; `changes` carries the hardship facts the 12.1 handler spreads onto the row.
    const changes32_10 = { ...((i.changes as Record<string, unknown> | undefined) ?? {}), ...(str(i, "hardship_reason") ? { hardship_reason: str(i, "hardship_reason") } : {}), ...(str(i, "qrpc_id") ? { qrpc_id: str(i, "qrpc_id") } : {}), ...(str(i, "hardship_nature") ? { hardship_nature: str(i, "hardship_nature") } : {}), ...(str(i, "hardship_text") ? { hardship_text: str(i, "hardship_text") } : {}) };
    const r = await delegate(rt, ctx, "12.1", "lossmit.application.open/update", { loan_id, utterance: str(i, "hardship_text") || "I need help with my mortgage payment", has_evaluative_info: hasEvaluative, confidence: 1, receipt_channel: "portal", received_on: ctx.now.slice(0, 10), state: str(i, "state") || "", submitted_by_party_id: str(i, "party_id") || null, ...(hasEvaluative ? { income: i.income ?? null, expenses: i.expenses ?? null } : {}), ...(str(i, "op") ? { op: str(i, "op") } : {}), ...(str(i, "id") ? { id: str(i, "id") } : {}), ...(str(i, "status") ? { status: str(i, "status") } : {}), ...(Object.keys(changes32_10).length ? { changes: changes32_10 } : {}), card_instance_id: cardId(i) }) as Record<string, unknown>;
    return ok("lossmit.requestAssistance", { loan_id, kind: hasEvaluative ? "application" : "rfa", application_id: (r as { application_id?: unknown })["application_id"] ?? (r as { id?: unknown })["id"] ?? null, status: (r as { status?: unknown })["status"] ?? null });
  }),
  // lossmit.respondToOffer → 12.2 lossmit.evaluation.*{offer_response}: `lossmit.offer.response.received`; REGX_1024_41E1_ACCEPT_14 running
  cmd("lossmit.respondToOffer", "act", async (i, ctx, rt) => {
    const loan_id = needLoan(i, ctx); need(i, "decision"); const d = str(i, "decision"); const response = d === "accept" || d === "accepted" || d === "yes" ? "accepted" : d === "decline" || d === "rejected" || d === "no" ? "rejected" : "";
    if (!response) throw new RangeError("decision must be accept or decline");
    const r = await delegate(rt, ctx, "12.2", "lossmit.evaluation.*", { op: "offer_response", loan_id, response, accepted_via: "portal", responded_on: ctx.now.slice(0, 10), ...(str(i, "evaluation_id") ? { evaluation_id: str(i, "evaluation_id") } : {}), ...(str(i, "offer_id") ? { offer_id: str(i, "offer_id") } : {}), card_instance_id: cardId(i) }) as Record<string, unknown>;
    ctx.events.append({ type: "lossmit.offer.response.received", loanId: loan_id, actor: ctx.actor, payload: { loan_id, response, via: "portal", card_instance_id: cardId(i), offer_id: (r as { id?: unknown })["id"] ?? str(i, "offer_id") ?? null } });
    return ok("lossmit.respondToOffer", { loan_id, response, via: "portal" });
  }, { guardrails: [guard("REGX_1024_41E1_ACCEPT_14", "02 §2 lossmit.respondToOffer: REGX_1024_41E1_ACCEPT_14 running", (_i, ctx) => (timerRunning(ctx, "REGX_1024_41E1_ACCEPT_14") ? undefined : "no loss-mitigation offer is open (the 14-day acceptance window is not running)"))] }),
  // lossmit.appeal → 12.2 lossmit.evaluation.*{appeal_receive} (12.3's lifecycle): `lossmit.appeal.received`; within 14 days of the denial notice (checked by 12.3)
  cmd("lossmit.appeal", "act", async (i, ctx, rt) => {
    const loan_id = needLoan(i, ctx); need(i, "text");
    const r = await delegate(rt, ctx, "12.2", "lossmit.evaluation.*", { op: "appeal_receive", loan_id, channel: "portal", received_on: ctx.now.slice(0, 10), received_at: ctx.now, text: str(i, "text"), written: true, ...(str(i, "evaluation_id") ? { evaluation_id: str(i, "evaluation_id") } : {}), ...(str(i, "application_id") ? { application_id: str(i, "application_id") } : {}), card_instance_id: cardId(i) }) as Record<string, unknown>;
    return ok("lossmit.appeal", { loan_id, appeal_id: (r as { appeal_id?: unknown })["appeal_id"] ?? (r as { id?: unknown })["id"] ?? null, status: (r as { status?: unknown })["status"] ?? "received" });
  }),
  // offer.respond → yes: 20.3 lead.created + 20.1 engaged; not_now: 20.1 declined (SM_REFI_RESOLICIT_COOLDOWN_90); never: declined + marketing consents revoked; refi_opportunities.status = offered
  cmd("offer.respond", "act", async (i, ctx, rt) => {
    const loan_id = needLoan(i, ctx); need(i, "decision", "opportunity_id"); const decision = str(i, "decision"); const opportunity_id = str(i, "opportunity_id");
    if (decision === "yes") {
      need(i, "partner_id", "partner_name");
      const lead_id = str(i, "lead_id") || randomUUID();
      await delegate(rt, ctx, "20.3", "deliverDisclosure", { op: "create", lead_id, partner_id: str(i, "partner_id"), partner_name: str(i, "partner_name"), channel: "refi_trigger", opportunity_id, loan_id, party_id: str(i, "party_id") || null, consumer_state: str(i, "consumer_state") || null, property_state: str(i, "property_state") || str(i, "consumer_state") || null, transaction_intent: "refinance", time_zone: str(i, "time_zone") || "America/New_York" });
      const r = await delegate(rt, ctx, "20.1", "emitOfferReady", { op: "engaged", opportunity_id, loan_id }) as Record<string, unknown>;
      return ok("offer.respond", { loan_id, opportunity_id, decision, lead_id, status: r["status"] });
    }
    if (decision !== "not_now" && decision !== "never") throw new RangeError("decision must be yes, not_now or never");
    const r = await delegate(rt, ctx, "20.1", "emitOfferReady", { op: "declined", opportunity_id, loan_id, reason: decision === "never" ? "never_proactive_offers" : "not_now" }) as Record<string, unknown>;
    if (decision === "never") {
      const party_id = str(i, "party_id") || null; const now = ctx.now;
      // 7.4's consents.status vocabulary (0076 check): a revocation is `withdrawn` with `revoked_at` and the reason — the event keeps the spec's word (`consent.marketing.revoked`)
      if (party_id) defer(rt, async (q) => { await q.query(`UPDATE consents SET status = 'withdrawn', revoked_at = $2, withdrawal_channel = 'portal', withdrawal_reason = 'never_proactive_offers' WHERE party_id = $1 AND purpose = 'marketing' AND (status IS NULL OR status NOT IN ('withdrawn', 'revoked'))`, [party_id, now]); });
      ctx.events.append({ type: "consent.marketing.revoked", loanId: loan_id, actor: ctx.actor, payload: { loan_id, party_id, opportunity_id, reason: "never_proactive_offers", borrower_initiated_path_open: true, card_instance_id: cardId(i) } });
    }
    return ok("offer.respond", { loan_id, opportunity_id, decision, status: r["status"], cooldown_until: r["cooldown_until"] ?? null, marketing_consent_revoked: decision === "never" });
  }, { guardrails: [guard("OFFER_NOT_OPEN", "02 §2 offer.respond: refi_opportunities.status = offered", (i, _c) => (i.opportunity_status !== undefined && !["offered", "offer_ready", "engaged"].includes(String(i.opportunity_status)) ? `the offer is ${String(i.opportunity_status)}, not open` : undefined))] }),
  // refi.request → 20.1 emitOfferReady{request}: refi_opportunities requested → offer_ready; a serviced loan
  cmd("refi.request", "act", async (i, ctx, rt) => {
    const loan_id = needLoan(i, ctx); need(i, "program_id");
    const r = await delegate(rt, ctx, "20.1", "emitOfferReady", { op: "request", loan_id, program_id: str(i, "program_id"), free_text: str(i, "free_text") || "I'd like to see if refinancing makes sense", ...(str(i, "transaction_type") ? { transaction_type: str(i, "transaction_type") } : {}), ...(i.cash_out_requested_cents !== undefined ? { cash_out_requested_cents: cents(i.cash_out_requested_cents) } : {}), human_agent: flag(i, "human_agent") }) as Record<string, unknown>;
    return ok("refi.request", { loan_id, opportunity_id: r["opportunity_id"], status: r["status"], escalation_kind: r["escalation_kind"] ?? null });
  }, { guardrails: [guard("NO_SERVICED_LOAN", "02 §2 refi.request: a serviced loan", (i, ctx) => (loanOf(i, ctx) ? undefined : "no serviced loan on this subject"))] }),
  // human.request → 4.3 human.transfer (a serviced loan) / 20.3 transfer_to_human (a lead) / the escalation directly: `human.transfer.requested`; always
  cmd("human.request", "act", async (i, ctx, rt) => {
    const reason = str(i, "reason") || "borrower_request"; let escalation: unknown = null;
    if (loanOf(i, ctx) && !appOf(i, ctx)) escalation = await delegate(rt, ctx, "4.3", "human.transfer", { loan_id: loanOf(i, ctx), reason, utterance: str(i, "utterance") || "human", payload: { reason, party_id: str(i, "party_id") || null, card_instance_id: cardId(i) } });
    else if (str(i, "lead_id") && str(i, "interaction_id")) escalation = await delegate(rt, ctx, "20.3", "deliverDisclosure", { op: "transfer_to_human", lead_id: str(i, "lead_id"), interaction_id: str(i, "interaction_id"), reason });
    else escalation = rt.escalations.open({ kind: "human_agent", ...(loanOf(i, ctx) ? { loanId: loanOf(i, ctx) } : {}), ...(appOf(i, ctx) ? { applicationId: appOf(i, ctx) } : {}), payload: { reason, party_id: str(i, "party_id") || null, card_instance_id: cardId(i), source: "borrower_app" } }, ctx.actor);
    ctx.events.append({ type: "human.transfer.requested", ...(loanOf(i, ctx) ? { loanId: loanOf(i, ctx) } : {}), ...(appOf(i, ctx) ? { applicationId: appOf(i, ctx) } : {}), actor: ctx.actor, payload: { reason, party_id: str(i, "party_id") || null, channel: str(i, "channel") || "app", card_instance_id: cardId(i), requested_at: ctx.now } });
    const e = escalation as { id?: unknown; escalation_id?: unknown } | null;
    return ok("human.request", { reason, escalation_id: e?.id ?? e?.escalation_id ?? null, requested_at: ctx.now });
  }, { guardrails: [never("HUMAN_PATH_ALWAYS_OPEN", "20.3 rule 12 / 01 §1.1: a request for a person is never refused", (i) => flag(i, "deny_transfer"), "a request for a person is never refused")] }),
  // party.updateContact → parties.contact / application_borrowers.contact (`party.contact.updated`); an address change on a serviced loan also opens the 10.1 address_change case; fresh L1
  cmd("party.updateContact", "write", async (i, ctx, rt) => {
    need(i, "party_id"); const party_id = str(i, "party_id"); const changes = Object.fromEntries(Object.entries(i).filter(([k, v]) => ["address", "phone", "email"].includes(k) && v !== undefined && v !== null));
    if (!Object.keys(changes).length) throw new RangeError("address, phone or email is required");
    const now = ctx.now; const abIds = list(i, "application_borrower_ids").map(String);
    defer(rt, async (q) => {
      await q.query(`UPDATE parties SET contact = contact || $2::jsonb WHERE id = $1`, [party_id, toJson({ ...changes, updated_at: now })]);
      for (const ab of abIds) await q.query(`UPDATE application_borrowers SET contact = coalesce(contact, '{}'::jsonb) || $2::jsonb WHERE id = $1 AND party_id = $3`, [ab, toJson(changes), party_id]);
    });
    ctx.events.append({ type: "party.contact.updated", ...(loanOf(i, ctx) ? { loanId: loanOf(i, ctx) } : {}), ...(appOf(i, ctx) ? { applicationId: appOf(i, ctx) } : {}), actor: ctx.actor, payload: { party_id, fields: Object.keys(changes), card_instance_id: cardId(i), updated_at: now } });   // never the values
    let case_id: string | null = null;
    if (changes["address"] !== undefined && loanOf(i, ctx)) { case_id = `CASE-${loanOf(i, ctx).slice(0, 8)}-${randomUUID().slice(0, 8)}`; await delegate(rt, ctx, "10.1", "case.*", { op: "write", id: case_id, loan_id: loanOf(i, ctx), data: { case_id, loan_id: loanOf(i, ctx), case_type: "address_change", status: "received", channel: "app", is_written: true, received_at: now, submitted_by_party_id: party_id } }); }
    return ok("party.updateContact", { party_id, fields: Object.keys(changes), case_id, updated_at: now });
  }, { guardrails: [FRESH_L1] }),
]);
