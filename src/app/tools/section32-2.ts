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

type Def = Omit<ToolDef, "process" | "agent">;
const cmd = (name: string, kind: ToolDef["kind"], handler: (i: ToolInput, ctx: CommandContext, rt: ToolRuntime) => unknown | Promise<unknown>, extra: Partial<Def> = {}): Def =>
  ({ name, kind, handler: compute(handler), decision: decisionFor(name), ...extra });

// ---------------------------------------------------------------- the 45 commands (02 §2 order)
export const TOOLS_32_2: readonly ToolDef[] = defineTools(PROCESS, BORROWER_APP, [
  // lead.start → 20.3 deliverDisclosure{create} then {start}: `lead.created`, `lead.interaction.started{channel, ai}`
  cmd("lead.start", "act", async (i, ctx, rt) => {
    need(i, "partner_id", "partner_name");
    const lead_id = str(i, "lead_id") || randomUUID(); const interaction_id = str(i, "interaction_id") || randomUUID();
    const created = await delegate(rt, ctx, "20.3", "deliverDisclosure", { op: "create", lead_id, partner_id: str(i, "partner_id"), partner_name: str(i, "partner_name"), channel: str(i, "lead_channel") || "organic", consumer_state: str(i, "consumer_state") || null, property_state: str(i, "property_state") || str(i, "consumer_state") || null, transaction_intent: str(i, "transaction_intent") || "undecided", party_id: str(i, "party_id") || null, source_touch_id: str(i, "utm_touch_id") || null, opportunity_id: str(i, "opportunity_id") || null, time_zone: str(i, "time_zone") || "America/New_York", utm: obj(i, "utm") }) as Record<string, unknown>;
    const started = await delegate(rt, ctx, "20.3", "deliverDisclosure", { op: "start", lead_id, interaction_id, channel: str(i, "channel") || "web_chat", ai: true }) as Record<string, unknown>;
    return ok("lead.start", { lead_id, interaction_id, status: created["status"], disclosure_required: started["disclosure_required"], co_preuse_notice: started["co_preuse_notice"] ?? null });
  }),
  // lead.acknowledgeAiDisclosure → 20.3 deliverDisclosure: `lead.disclosure.delivered`, `consent.ai_disclosure.acknowledged`
  cmd("lead.acknowledgeAiDisclosure", "act", async (i, ctx, rt) => {
    need(i, "lead_id", "interaction_id");
    const r = await delegate(rt, ctx, "20.3", "deliverDisclosure", { lead_id: str(i, "lead_id"), interaction_id: str(i, "interaction_id"), notice_id: str(i, "notice_id") || null, ...(str(i, "disclosure_version_id") ? { version: str(i, "disclosure_version_id") } : {}) }) as Record<string, unknown>;
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
    need(i, "kind", "party_id", "method"); const kind = str(i, "kind"); const scope = list(i, "scope").map(String); const consent_id = str(i, "consent_id") || randomUUID();
    const platformKind = kind === "autodraft_authorization" ? "autopay" : kind;
    const status = kind === "esign" ? "pending_verification" : "active";   // 7.4's consents.status vocabulary: the E-SIGN demonstration test runs out of band before `active`
    let delegated: Record<string, unknown> | null = null;
    if (str(i, "lead_id") && ["esign", "tcpa_voice", "tcpa_sms", "credit_authorization"].includes(kind)) {
      delegated = await delegate(rt, ctx, "20.3", "captureConsent", kind === "esign" ? { lead_id: str(i, "lead_id"), kind, consent_id, party_id: str(i, "party_id"), scopes: scope.length ? scope : ["disclosures", "notices"], disclosure_version: str(i, "disclosure_version_id"), captured_via: str(i, "channel") === "voice" ? "voice" : "portal", clicked_at: ctx.now, ip: str(i, "ip") || null, user_agent: str(i, "user_agent") || null }
        : kind === "credit_authorization" ? { lead_id: str(i, "lead_id"), kind, authorization_id: consent_id, authorization_kind: str(i, "authorization_kind") || "soft_prequal", party_id: str(i, "party_id"), text_version: str(i, "text_hash") || str(i, "disclosure_version_id"), channel: "web_chat", end_user: "partner", evidence: { ip: str(i, "ip") || null, user_agent: str(i, "user_agent") || null, card_instance_id: cardId(i) } }
        : { lead_id: str(i, "lead_id"), kind, consent_id, party_id: str(i, "party_id"), number: str(i, "phone_number") }) as Record<string, unknown>;
    } else if (loanOf(i, ctx)) {
      delegated = await delegate(rt, ctx, "2.3", "consent.capture", { id: consent_id, loan_id: loanOf(i, ctx), data: { consent_id, loan_id: loanOf(i, ctx), party_id: str(i, "party_id"), kind: platformKind, scope, status, method: str(i, "method"), channel: "portal", disclosure_version_id: str(i, "disclosure_version_id") || null, text_hash: str(i, "text_hash") || null, purpose: str(i, "purpose") || "informational", captured_at: ctx.now } }) as Record<string, unknown>;
    }
    ctx.events.append({ type: `consent.granted`, ...(appOf(i, ctx) ? { applicationId: appOf(i, ctx) } : {}), actor: ctx.actor, payload: { consent_id, kind: platformKind, ux_kind: kind, party_id: str(i, "party_id"), scope, status, method: str(i, "method"), disclosure_version_id: str(i, "disclosure_version_id") || null, card_instance_id: cardId(i), standing: flag(i, "standing") } });
    if (kind === "esign") ctx.events.append({ type: "consent.esign.pending", ...(appOf(i, ctx) ? { applicationId: appOf(i, ctx) } : {}), actor: ctx.actor, payload: { consent_id, party_id: str(i, "party_id"), scope, verification_email: "NTC_ESIGN_VERIFICATION_EMAIL" } });
    const application_id = appOf(i, ctx) || null; const loan_id = loanOf(i, ctx) || null; const party_id = str(i, "party_id"); const lead_id = str(i, "lead_id") || null;
    // consents.disclosure_version_id is a uuid (the consent_disclosure_versions row); a card's version label that is not one lands in hw_sw_version (7.4's statement version) beside the text hash
    const versionId = str(i, "disclosure_version_id"); const versionUuid = isUuid(versionId) ? versionId : null; const versionLabel = versionUuid ? null : versionId || null;
    defer(rt, async (q) => { await q.query(`INSERT INTO consents (id, kind, granted, provenance, verified, captured_at, scope, status, disclosure_version_id, hw_sw_version, captured_via, application_id, loan_id, lead_id, party_id, purpose, disclosure_text_hash, standing, loan_ids)
      VALUES ($1, $2::consent_kind, true, 'portal', $3, $4, $5::text[], $6, $7, $8, 'portal', $9, $10, $11, $12, $13, $14, $15, $16::uuid[])`,
      [consent_id, platformKind, kind !== "esign", ctx.now, scope, status, versionUuid, versionLabel, application_id, loan_id, lead_id, party_id, str(i, "purpose") || "informational", str(i, "text_hash") || null, flag(i, "standing"), loan_id ? [loan_id] : []]); });
    return ok("consent.capture", { consent_id, kind: platformKind, status, scope, party_id, verification_email: kind === "esign" ? "NTC_ESIGN_VERIFICATION_EMAIL" : null, delegated: delegated ? Object.fromEntries(Object.entries(delegated).filter(([k]) => ["consent_id", "status", "scope", "authorization_id", "permissible_purpose"].includes(k))) : null });
  }, { guardrails: [NOT_VOICE("a consent"),
    never("AFFIRMATION_METHOD", "01 §3.5: esign / credit_authorization / autodraft_authorization need checkbox_with_text + typed name; ai_disclosure_ack a single tap", (i) => ["esign", "credit_authorization", "autodraft_authorization", "tcpa_voice", "tcpa_sms"].includes(str(i, "kind")) && str(i, "method") !== "" && str(i, "method") !== "checkbox_with_text", "this consent kind is affirmed by checkbox_with_text and a typed name")] }),
  // credit.authorize → 20.3 captureConsent{credit_authorization}: `credit.authorization.captured{kind}`; L2 for a soft pull, L3 for a hard pull
  cmd("credit.authorize", "act", async (i, ctx, rt) => {
    need(i, "kind", "lead_id", "text_hash"); const kind = str(i, "kind"); const authorization_id = str(i, "authorization_id") || randomUUID();
    const r = await delegate(rt, ctx, "20.3", "captureConsent", { lead_id: str(i, "lead_id"), kind: "credit_authorization", authorization_id, authorization_kind: kind === "hard_pull" ? "hard_application" : "soft_prequal", party_id: str(i, "party_id") || null, text_version: str(i, "text_hash"), channel: "web_chat", end_user: "partner", evidence: { signature: str(i, "signature") || null, card_instance_id: cardId(i), ip: str(i, "ip") || null } }) as Record<string, unknown>;
    ctx.events.append({ type: "credit.authorization.captured", actor: ctx.actor, payload: { kind, authorization_id, lead_id: str(i, "lead_id"), party_id: str(i, "party_id") || null, text_hash: str(i, "text_hash"), card_instance_id: cardId(i) } });
    const pulled = kind === "soft_pull" && i.order_pull !== false ? await delegate(rt, ctx, "20.3", "orderSoftPull", { lead_id: str(i, "lead_id"), requested_by: "consumer" }) as Record<string, unknown> : null;
    return ok("credit.authorize", { kind, authorization_id, permissible_purpose: r["permissible_purpose"], soft_pull_requested: !!pulled });
  }, { guardrails: [never("LEVEL_REQUIRED", "02 §2 credit.authorize: L2 (soft) / L3 (hard)", (i) => str(i, "kind") === "hard_pull" ? !levelAtLeast(i, "L3") : !levelAtLeast(i, "L2"), "a soft pull needs an L2 session and a hard pull an L3 session"),
    never("CREDIT_AUTHORIZATION_KIND", "02 §2: kind ∈ {soft_pull, hard_pull}", (i) => str(i, "kind") !== "" && !["soft_pull", "hard_pull"].includes(str(i, "kind")), "kind must be soft_pull or hard_pull")] }),
  // application.confirmField → 21.1 confirmPrefill (a six-item prefill) / captureField (any other path): the O2.1 rule-1 event
  cmd("application.confirmField", "write", async (i, ctx, rt) => {
    const application_id = needApp(i, ctx); need(i, "path"); const path = str(i, "path"); const item = path.replace(/^application\./, "");
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
  }, { guardrails: [never("DEMOGRAPHICS_OWN_PARTY_ONLY", "02 §2 / 01 §3.19: own party only — never inferred, never answered for another borrower", (i) => str(i, "own_borrower_id") !== "" && str(i, "own_borrower_id") !== str(i, "borrower_id"), "a party answers the demographic questions only for themself"),
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
    const application_id = needApp(i, ctx); need(i, "role"); const contact = obj(i, "contact"); const role = str(i, "role");
    if (!["co_borrower", "non_borrowing_spouse", "poa", "authorized_third_party"].includes(role)) throw new RangeError("role must be co_borrower, non_borrowing_spouse, poa or authorized_third_party");
    if (!contact["email"] && !contact["phone"]) throw new RangeError("contact.email or contact.phone is required");
    const legal_name = str(i, "legal_name") || String(contact["name"] ?? "") || "Invited party"; const ab_id = randomUUID(); const party_id = randomUUID(); const now = ctx.now;
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
    const r = await delegate(rt, ctx, "22.1", "ingestDocument", { application_id, document_id: str(i, "document_id"), source_channel: "borrower_upload", sha256: str(i, "sha256"), page_count: Number(i.page_count ?? 0), declared_class: str(i, "document_class") || null, subject_borrower_id: str(i, "borrower_id") || null, ...(list(i, "applicant_borrower_ids").length ? { applicant_borrower_ids: i.applicant_borrower_ids } : {}), sender_identity: { party_id: str(i, "party_id") || null, card_instance_id: cardId(i) }, received_at: ctx.now }) as Record<string, unknown>;
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
    const received_on = ctx.now.slice(0, 10);
    ctx.events.append({ type: `disclosure.${kind}.received`, applicationId: application_id, aggregate: { kind: "disclosure", id: disclosure_id }, actor: ctx.actor, payload: { application_id, disclosure_id, borrower_id: str(i, "consumer_id"), evidence: "esign_confirmed", receipt_evidence: "esign_confirmed", evidence_kind: "portal_acknowledgement", received_on, effective_receipt_date: received_on, card_instance_id: cardId(i) } });
    if (row) rt.store.put("disclosures", disclosure_id, { ...row, status: "received", effective_receipt_date: (row["effective_receipt_date"] as string | undefined) ?? received_on, receipt_evidence: "esign_confirmed" }, ctx.actor, ctx.now);
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
  }),
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
    const application_id = needApp(i, ctx); need(i, "document_id");
    const r = await delegate(rt, ctx, "24.5", "extractEvidence", { application_id, kind: str(i, "kind") || "hoi_declaration", document_id: str(i, "document_id"), received_at: ctx.now, fields: obj(i, "fields"), confidence: obj(i, "confidence"), source: str(i, "carrier_connection_id") ? "carrier_connect_FAKE" : "borrower_upload" }) as Record<string, unknown>;
    return ok("insurance.submitEvidence", { application_id, document_id: str(i, "document_id"), evidence_id: r["evidence_id"], status: r["status"], confirmation_required: r["confirmation_required"] ?? false });
  }),
  // closing.selectSlot → 26.2 runPreSessionChecks{schedule}: `closing.scheduled`; decision sub-status clear_to_close; SM_O72_RON_STATE_AUTH_GATE inside 26.2
  cmd("closing.selectSlot", "act", async (i, ctx, rt) => {
    const application_id = needApp(i, ctx); need(i, "slot", "state", "settlement_agent_party_id", "transaction_type");
    const closing_id = str(i, "closing_id") || `CLS-${application_id.slice(0, 8)}`;
    const r = await delegate(rt, ctx, "26.2", "runPreSessionChecks", { application_id, op: "schedule", closing_id, scheduled_at: str(i, "slot"), time_zone: str(i, "time_zone") || "America/New_York", state: str(i, "state"), county_fips: str(i, "county_fips") || null, transaction_type: str(i, "transaction_type"), dry_state: flag(i, "dry_state"), settlement_agent_party_id: str(i, "settlement_agent_party_id"), notary_party_id: str(i, "notary_party_id") || null, ron_provider_party_id: str(i, "ron_provider_party_id") || null, eligibility: list(i, "eligibility"), signers: list(i, "signers"), closing_type_preference: str(i, "closing_type_preference") || null }) as Record<string, unknown>;
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
    const data: Record<string, unknown> = { enrollment_id: id, loan_id, status, ...(verb === "enroll" || verb === "change" ? { amount_rule: str(i, "amount_rule") || "contractual", draft_day: Number(i.draft_day ?? 1), include_fees: flag(i, "include_fees"), account_last4: String(account["last4"] ?? account["account_last4"] ?? "").slice(-4) || null, account_type: (account["type"] as string | undefined) ?? null, channel: "portal", automation_disclosed: true, human_offered: true, elements_displayed: true, ...(i.extra_principal_cents !== undefined ? { extra_principal_cents: cents(i.extra_principal_cents) } : {}), ...(i.fixed_amount_cents !== undefined ? { fixed_amount_cents: cents(i.fixed_amount_cents) } : {}) } : {}), ...(verb === "revoke" ? { revoked_at: ctx.now, revocation_source: "portal" } : {}), ...(verb === "pause" ? { paused_at: ctx.now } : {}), card_instance_id: cardId(i), version_at: ctx.now };
    if (verb === "enroll" || verb === "change") { const d = Number(data["draft_day"]); if (!(d >= 1 && d <= 16)) throw new RangeError("draft_day must be 1–16"); }
    await delegate(rt, ctx, "2.3", "autodraft.read/write", { op: "write", id, loan_id, data });
    ctx.events.append({ type: verb === "revoke" ? "autodraft.enrollment.revoked" : verb === "pause" ? "autodraft.enrollment.paused" : "autodraft.enrollment.requested", loanId: loan_id, aggregate: { kind: "autodraft_enrollment", id }, actor: ctx.actor, payload: { enrollment_id: id, loan_id, verb, status, draft_day: data["draft_day"] ?? null, amount_rule: data["amount_rule"] ?? null, include_fees: data["include_fees"] ?? null, card_instance_id: cardId(i), copy_due: "SM_AUTODRAFT_COPY_DELIVERY_1BD" } });
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
    const r = await delegate(rt, ctx, "3.6", "recordBorrowerElection", { loan_id, election: { election_id: str(i, "election_id") || `EL-${loan_id.slice(0, 8)}-${randomUUID().slice(0, 8)}`, kind: option === "lump_sum" ? "lump_sum" : "spread", months: option === "spread_12" ? 12 : null, evidence_document_id: cardId(i) || str(i, "evidence_document_id") || `card-${randomUUID()}`, analysis_id: str(i, "analysis_id") || undefined, recorded_on: ctx.now.slice(0, 10) } }) as Record<string, unknown>;
    return ok("escrow.electShortage", { loan_id, option, election_id: r["election_id"], kind: r["kind"], months: r["months"] ?? null });
  }, { guardrails: [FRESH_L1, guard("ESCROW_STATEMENT_NOT_SENT", "02 §2 escrow.electShortage: analysis statement_sent", (i, ctx) => (i.analysis_status !== undefined ? (["statement_sent", "effective"].includes(String(i.analysis_status)) ? undefined : `the analysis is ${String(i.analysis_status)}, not statement_sent`) : hasEvent(ctx, /^escrow\.(analysis\.(completed|approved)|statement\.(sent|rendered))$/) ? undefined : "no escrow analysis statement has been sent"))] }),
  // escrow.requestWaiver → 3.8 evaluateWaiver (eligibility): escrowed → evaluating
  cmd("escrow.requestWaiver", "act", async (i, ctx, rt) => {
    const loan_id = needLoan(i, ctx);
    ctx.events.append({ type: "escrow.waiver.requested", loanId: loan_id, actor: ctx.actor, payload: { loan_id, requested_at: ctx.now, channel: "portal", card_instance_id: cardId(i) } });
    const request = obj(i, "request"); if (!Object.keys(request).length) return ok("escrow.requestWaiver", { loan_id, status: "evaluating", evaluated: false, next: "3.8 evaluateWaiver with the loan's facts" });
    const r = await delegate(rt, ctx, "3.8", "evaluateWaiver", { loan_id, request: { requested_on: ctx.now.slice(0, 10), ...request } }) as Record<string, unknown>;
    return ok("escrow.requestWaiver", { loan_id, status: "evaluating", evaluated: true, decision: r });
  }),
  // pmi.requestCancellation → 10.1 pmi.*{request}: `mi.cancel.requested` + the pmi_cancel case; mi_policies active
  cmd("pmi.requestCancellation", "act", async (i, ctx, rt) => {
    const loan_id = needLoan(i, ctx);
    const r = await delegate(rt, ctx, "10.1", "pmi.*", { op: "request", loan_id, channel: "portal", requested_at: ctx.now, request: { loan_id, channel: "portal", written: true, received_on: ctx.now.slice(0, 10), card_instance_id: cardId(i), ...obj(i, "request") }, ...Object.fromEntries(Object.entries(i).filter(([k]) => !["op", "loan_id", "request", "card_instance_id", "party_id", "fresh_l1"].includes(k))) }) as Record<string, unknown>;
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
    const loan_id = needLoan(i, ctx); const hasEvaluative = i.income !== undefined || i.expenses !== undefined || list(i, "documents").length > 0;
    const r = await delegate(rt, ctx, "12.1", "lossmit.application.open/update", { loan_id, utterance: str(i, "hardship_text") || "I need help with my mortgage payment", has_evaluative_info: hasEvaluative, confidence: 1, receipt_channel: "portal", received_on: ctx.now.slice(0, 10), state: str(i, "state") || "", submitted_by_party_id: str(i, "party_id") || null, ...(hasEvaluative ? { income: i.income ?? null, expenses: i.expenses ?? null } : {}), card_instance_id: cardId(i) }) as Record<string, unknown>;
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
      if (party_id) defer(rt, async (q) => { await q.query(`UPDATE consents SET status = 'revoked', revoked_at = $2, withdrawal_channel = 'portal', withdrawal_reason = 'never_proactive_offers' WHERE party_id = $1 AND purpose = 'marketing' AND (status IS NULL OR status <> 'revoked')`, [party_id, now]); });
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
