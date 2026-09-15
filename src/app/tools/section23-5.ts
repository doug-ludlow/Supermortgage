/**
 * §23.5 process-owned tools — the `underwriter` agent's eleven tools over the DU relationship graph
 * (spec/sections/23-desktop-underwriter-and-the-credit-decision/23-5-*.md "AI agent design"), defined with
 * `defineTools("23.5", "underwriter", defs)` and spread by ./index.ts. Every tool string is one
 * spec/registry/agents.json names for 23.5; src/app/tools.test.ts refuses the rest.
 *
 *   writeDuAsset / writeDuLiability / writeDuExpense   write  the row and its owners together (src/domain/underwriting/du/writer.ts):
 *                                                             a write with no owner is refused here before the database refuses it at COMMIT
 *   writeDuOwnedProperty                               write  the OWNED_PROPERTY asset, its owners and its 3a row; `lien_upb_cents` and `application_id` are never inputs (rule 3, T13)
 *   linkOwner / unlinkOwner                            write  one ASSET/LIABILITY/EXPENSE_IsAssociatedWith_ROLE arc; the last arc's removal is what COMMIT refuses (T2)
 *   assertDeclarations                                 write  the fourteen URLA section 5 answers, follow-ups, chapters and the borrower's written explanation — a HUMAN act of the
 *                                                             declaring borrower's own actor (humanRoles: borrower; the actor is the command's, never an input; rule 4, T6, T7)
 *   writeResidence                                     write  the Current residence with its basis (Rent carries the monthly rent) or a Prior one (T8)
 *   appendBorrower                                     write  a borrowing party in position 2..4 (the database allocates under the application's row lock; rule 6, T9)
 *   linkJointCreditReport                              write  ROLE_SharesJointCreditReportWith_ROLE: from_ the additional borrower(s), to_ the group's primary (T12)
 *   readDuGraph                                        read   every live container with its arcs, for 23.6 and the examiner
 *
 * Every write is deferred into the command's transaction (`rt.services.deferWrite`, src/runtime/app.ts) so the deferred
 * constraint triggers of db/migrations/*_du_graph.sql judge the whole set at COMMIT; a harness with no transaction
 * (services without deferWrite) refuses the write with PortUnavailable rather than writing a row alone. The id a
 * writer reports — and the `du.graph.*.written` event it appends — is the row the deferred write lands on: the owners
 * and the identity key are resolved BEFORE the transaction on the committed state (`rt.services.db`), a re-pull's
 * matched row is looked up there (writer.ts lookupByIdentity), and the deferred write asserts it landed on that id
 * (DU_WRITER_IDENTITY_MOVED refuses the command when a concurrent pull committed the key in between). `matched` on the
 * output and the event says whether the row existed. Decision
 * record: none of the tools' own — every write cites the 22.x/21.x decision that produced the data (`cites_decision_id`
 * on the event payload) and `decision: () => null` leaves no row of its own. A borrower is named by any id the caller
 * holds (the application_borrowers row, the party, the servicing borrower, or 21.1's intake id) and resolved to the
 * edge inside the transaction (writer.ts resolveBorrowerEdge). Guardrails: DU_DECLARATION_NOT_SELF_ATTESTED (an agent,
 * or another party, asserting a declaration), DU_DECLARATION_ACTOR_FROM_CONTEXT (an actor in the input),
 * DU_DECLARATION_NEVER_DERIVED (a declaration sourced from a report), DU_OWNED_PROPERTY_DERIVED_FIELD, DU_GRAPH_ORPHAN
 * (a row with no owner), DU_ARC_DISPUTED (a caller choosing an endpoint for the two disputed arcs — Open question 2).
 * assertDeclarations runs as the COMMAND's actor and no other: `duTool` inherits ctx.actor for it and refuses a caller
 * naming one, so the borrower's session actor the API executes 32.2 application.answerDeclarations as is the only actor
 * that can reach the row (a bus caller acting as an agent, the platform or staff is refused before anything runs).
 */
import { randomUUID } from "node:crypto";
import { defineTools, compute, never, guard, cents, str, flag, toolCommand, PortUnavailable, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import { CommandBus, type CommandContext } from "../commands.ts";
import { AgentRegistry } from "../agents.ts";
import type { Queryable } from "../../infra/db/client.ts";
import type { Actor } from "../../kernel/events/index.ts";
import {
  writeAsset, writeLiability, writeExpense, writeOwnedProperty, linkOwner, unlinkOwner, assertDeclarations, writeResidence, appendBorrower, linkJointCreditReport, resolveBorrowerEdge, lookupByIdentity, assertLanded,
  DU_DECLARATION_ANSWERS, DU_DECLARATION_FOLLOW_UPS, DU_OWNED_PROPERTY_DERIVED, type DuOwner, type NonEmpty, type OwnedKind, type DuAssetRow, type DuLiabilityRow, type DuExpenseRow, type DuOwnedPropertyRow, type DuResidenceRow,
} from "../../domain/underwriting/du/writer.ts";
import { readDuGraph } from "../../domain/underwriting/du/graph.ts";
import { assetIdentityKeys, liabilityIdentityKeys, MANUAL_PREFIX, type AssetIdentityFacts, type LiabilityIdentityFacts } from "../../domain/underwriting/du/identity.ts";

type P = Record<string, unknown>;
export const PROCESS_23_5 = "23.5";
export const UNDERWRITER = "underwriter";
export const UNDERWRITER_ACTOR: Actor = { kind: "agent", id: UNDERWRITER };
const RULE_SET = "23.5@du-graph.v1";

// ───────── helpers ─────────
const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const obj = (v: unknown): P => (v && typeof v === "object" && !Array.isArray(v) ? (v as P) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const appOf = (i: ToolInput, ctx: CommandContext): string => { const id = str(i, "application_id") || ctx.applicationId || ""; if (!id) throw new RangeError("application_id is required (an application-scoped command)"); return id; };
const dbOf = (rt: ToolRuntime): Queryable => { const db = rt.services["db"] as Queryable | undefined; if (!db) throw new PortUnavailable("service:db"); return db; };
type Defer = (fn: (q: Queryable) => Promise<void>) => void;
const deferOf = (rt: ToolRuntime): Defer => { const d = rt.services["deferWrite"] as Defer | undefined; if (!d) throw new PortUnavailable("service:deferWrite"); return d; };
/** True when this runtime commits tool writes in a transaction — the callers in 22.x / 32.2 write the graph only then (a unit harness without one keeps its in-memory records). */
export const hasTransaction = (rt: ToolRuntime): boolean => typeof rt.services["deferWrite"] === "function";
const optCents = (v: unknown): bigint | null => (v === undefined || v === null || v === "" ? null : cents(v));
/** A row's columns as given, with `*_cents` revived to bigint and empty strings read as null. */
const row = (v: unknown): P => Object.fromEntries(Object.entries(obj(v)).map(([k, x]) => [k, k.endsWith("_cents") ? optCents(x) : x === "" ? null : x]));
/** The owners a caller named: `owners: [{application_borrower_id | borrower_id | borrower_ref, role?}]`, or the shorthand `borrower_ids: [..]`. */
const ownerRefs = (i: ToolInput, key: string): { ref: string; role?: string }[] => {
  const named = list(i[key]).map((o) => (typeof o === "string" ? { ref: o } : { ref: String(obj(o)["application_borrower_id"] ?? obj(o)["borrower_id"] ?? obj(o)["borrower_ref"] ?? ""), ...(typeof obj(o)["role"] === "string" ? { role: String(obj(o)["role"]) } : {}) }));
  const shorthand = list(i["borrower_ids"]).map((b) => ({ ref: String(b) }));
  return [...named, ...shorthand].filter((o) => o.ref);
};
const resolveOwners = async (q: Queryable, app: string, refs: readonly { ref: string; role?: string }[]): Promise<NonEmpty<DuOwner>> => {
  const out: DuOwner[] = [];
  for (const r of refs) out.push({ applicationBorrowerId: await resolveBorrowerEdge(q, app, r.ref), ...(r.role ? { role: r.role } : {}) });
  if (!out.length) throw new RangeError("at least one owner is required");
  return out as unknown as NonEmpty<DuOwner>;
};
const supersedesOf = (i: ToolInput) => { const s = obj(i["supersedes"]); return typeof s["id"] === "string" ? { id: String(s["id"]), ...(s["retired_by_verification_id"] !== undefined ? { retiredByVerificationId: s["retired_by_verification_id"] as string | null } : {}) } : undefined; };
const citation = (i: ToolInput): P => (typeof i["cites_decision_id"] === "string" ? { cites_decision_id: i["cites_decision_id"] } : {});

// ───────── guardrails ─────────
const DISPUTED = /UNDERWRITING_VERIFICATION_IsAssociatedWith_(ASSET|EMPLOYER)/;
const NO_DISPUTED_ENDPOINT = never("DU_ARC_DISPUTED", "23.5 AI agent design / Open question 2: the two UNDERWRITING_VERIFICATION_* arcs' endpoints disagree with their arcrole names; the generated table carries both names and picks neither",
  (i) => DISPUTED.test(str(i, "arcrole")) || DISPUTED.test(str(i, "arc")) || i["endpoint"] !== undefined || i["disputed_endpoint"] !== undefined, "no writer chooses an endpoint for a disputed arc; 23.6 refuses to emit either until Fannie Mae answers");
const owned = (key: string) => never("DU_GRAPH_ORPHAN", "23.5 rule 1: ownership is a join table, never none — the row and its owners are written together", (i) => ownerRefs(i, key).length === 0, `${key} must name at least one borrowing party; a row with none cannot be emitted`);
const NO_DERIVED_PROPERTY_FIELDS = never("DU_OWNED_PROPERTY_DERIVED_FIELD", "23.5 rule 3 / T13: application_id is inherited from the asset and lien_upb_cents is re-summed from the liabilities securing the row", (i) => DU_OWNED_PROPERTY_DERIVED.some((k) => k in obj(i["property"])), "never write application_id or lien_upb_cents on an owned property");
export const SELF_ATTESTED = guard("DU_DECLARATION_NOT_SELF_ATTESTED", "23.5 rule 4 / T6: only the declaring borrower's own actor asserts URLA section 5", (_i, ctx) => (ctx.actor.kind === "human" && ctx.actor.role === "borrower" ? undefined : `a ${ctx.actor.kind} actor (${ctx.actor.id}${ctx.actor.role ? ` / ${ctx.actor.role}` : ""}) may not declare on a borrower's behalf`));
const ACTOR_FROM_CONTEXT = never("DU_DECLARATION_ACTOR_FROM_CONTEXT", "23.5 Data model: asserted_by_actor is the kernel Actor of the borrower's own session, stamped by 32.2 — never the client's claim", (i) => i["asserted_by_actor"] !== undefined || i["actor"] !== undefined, "the asserting actor is the command's actor; it is not an input");
const NEVER_DERIVED = never("DU_DECLARATION_NEVER_DERIVED", "23.5 rule 4: no code path writes a declaration from a credit report, a lien search or a property record", (i) => /credit_report|lien_search|property_record|derived/i.test(str(i, "source") + str(i, "derived_from")), "a declaration is asked, never derived");

/**
 * Execute one 23.5 tool NESTED on the same bus, inside the same unit of work, as the underwriter agent (or as the actor
 * given). assertDeclarations is the exception: it runs as the COMMAND's own actor, inherited from ctx — a caller naming
 * an actor for it is refused (DU_DECLARATION_ACTOR_FROM_CONTEXT), because an actor a caller names is one it could forge,
 * and the row's `asserted_by_actor` must be the borrower's own session (23.5 Data model, T6, T7).
 */
let fallbackRegistry: AgentRegistry | undefined;
export async function duTool(rt: ToolRuntime, ctx: CommandContext, name: string, input: ToolInput, actor?: Actor): Promise<unknown> {
  const def = TOOLS_23_5.find((t) => t.name === name);
  if (!def) throw new PortUnavailable(`tool:23.5 ${name}`);
  if (name === "assertDeclarations" && actor !== undefined && (actor.kind !== ctx.actor.kind || actor.id !== ctx.actor.id || (actor.role ?? null) !== (ctx.actor.role ?? null))) {
    throw new RangeError("DU_DECLARATION_ACTOR_FROM_CONTEXT: assertDeclarations runs as the command's own actor; a caller does not name who declares");
  }
  const as: Actor = name === "assertDeclarations" ? ctx.actor : (actor ?? UNDERWRITER_ACTOR);
  let agents = rt.services["agents"] as AgentRegistry | undefined;
  if (!agents) { fallbackRegistry ??= new AgentRegistry(); agents = fallbackRegistry; }
  agents.registerTool(def.agent, def.name);
  const r = await new CommandBus(agents).execute(toolCommand(def, rt, ["underwriting_reviewer"]), as, input, ctx, ctx.run ? { run: ctx.run } : {});
  return r.output;
}

// ───────── the eleven ─────────
export const TOOLS_23_5: readonly ToolDef[] = defineTools(PROCESS_23_5, UNDERWRITER, [
  { name: "writeDuAsset", kind: "write", ruleSetVersion: RULE_SET, guardrails: [owned("owners"), NO_DISPUTED_ENDPOINT],
    handler: compute(async (i, ctx, rt) => {
      const app = appOf(i, ctx); const defer = deferOf(rt); const db = dbOf(rt); const a = row(i["asset"]); need(a as ToolInput, "kind");
      const owners = ownerRefs(i, "owners"); const minted = str(i, "asset_id") || (typeof a["id"] === "string" ? String(a["id"]) : randomUUID());
      const identity = obj(i["identity"]); const match = flag(i, "match_on_identity");
      // Resolved BEFORE the transaction, on the committed state: the owners' edges, then the identity key — the caller's, else computed from the vendor item and the
      // row's facts with the FIRST owner as the subject borrower (identity.ts), else a person's own `manual:` key — then, for a re-pull, the row the key already names.
      // The id reported below is that row's, else the minted one; the deferred write asserts it landed there (DU_WRITER_IDENTITY_MOVED), so the output, 22.4's
      // `du_graph.assets[]` and `du.graph.asset.written` never name a uuid that no du_assets row carries.
      const resolved = await resolveOwners(db, app, owners);
      let identityKey = typeof a["identity_key"] === "string" && a["identity_key"] ? String(a["identity_key"]) : ""; let priorKeys = list(i["prior_identity_keys"]).map(String);
      if (!identityKey && identity["facts"]) { const k = assetIdentityKeys({ applicationBorrowerId: resolved[0].applicationBorrowerId, provider: str(identity as ToolInput, "provider") || "manual", itemId: (identity["item_id"] as string | null | undefined) ?? null }, obj(identity["facts"]) as unknown as AssetIdentityFacts); identityKey = k.key; priorKeys = [...priorKeys, ...k.priorKeys]; }
      if (!identityKey) identityKey = `${MANUAL_PREFIX}${minted}`;
      const found = match ? await lookupByIdentity(db, "du_assets", app, [identityKey, ...priorKeys]) : null;
      const id = found?.id ?? minted;
      defer(async (q) => {
        const w = await writeAsset(q, { asset: { ...(a as DuAssetRow), id, application_id: app, kind: String(a["kind"]), identity_key: identityKey }, owners: resolved, matchOnIdentity: match, ...(match ? { priorIdentityKeys: priorKeys } : {}), supersedes: supersedesOf(i) });
        assertLanded("writeDuAsset", "du_assets", id, w.id);
      });
      ctx.events.append({ type: "du.graph.asset.written", applicationId: app, aggregate: { kind: "du_assets", id }, actor: ctx.actor, payload: { application_id: app, asset_id: id, kind: String(a["kind"]), asset_type: a["asset_type"] ?? null, owners: owners.map((o) => o.ref), match_on_identity: match, matched: found !== null, identity_key: identityKey, supersedes: supersedesOf(i)?.id ?? null, ...citation(i) } });
      return { asset_id: id, application_id: app, kind: String(a["kind"]), owners: owners.map((o) => o.ref), match_on_identity: match, matched: found !== null, identity_key: identityKey };
    }), decision: () => null },

  { name: "writeDuLiability", kind: "write", ruleSetVersion: RULE_SET, guardrails: [owned("obligors"), NO_DISPUTED_ENDPOINT],
    handler: compute(async (i, ctx, rt) => {
      const app = appOf(i, ctx); const defer = deferOf(rt); const db = dbOf(rt); const l = row(i["liability"]); need(l as ToolInput, "liability_type", "creditor_name");
      const obligors = ownerRefs(i, "obligors"); const minted = str(i, "liability_id") || (typeof l["id"] === "string" ? String(l["id"]) : randomUUID());
      const identity = obj(i["identity"]); const match = flag(i, "match_on_identity");
      // The same lookup-before as writeDuAsset: obligors, key and (for a re-pull) the matched row on the committed state; the id reported is the row's.
      const resolved = await resolveOwners(db, app, obligors);
      let identityKey = typeof l["identity_key"] === "string" && l["identity_key"] ? String(l["identity_key"]) : ""; let priorKeys = list(i["prior_identity_keys"]).map(String);
      if (!identityKey && identity["facts"]) { const k = liabilityIdentityKeys({ applicationBorrowerId: resolved[0].applicationBorrowerId, provider: str(identity as ToolInput, "provider") || "manual", itemId: (identity["item_id"] as string | null | undefined) ?? null }, obj(identity["facts"]) as unknown as LiabilityIdentityFacts); identityKey = k.key; priorKeys = [...priorKeys, ...k.priorKeys]; }
      if (!identityKey) identityKey = `${MANUAL_PREFIX}${minted}`;
      const found = match ? await lookupByIdentity(db, "du_liabilities", app, [identityKey, ...priorKeys]) : null;
      const id = found?.id ?? minted;
      defer(async (q) => {
        const w = await writeLiability(q, { liability: { ...(l as DuLiabilityRow), id, application_id: app, monthly_payment_cents: optCents(l["monthly_payment_cents"]) ?? 0n, unpaid_balance_cents: optCents(l["unpaid_balance_cents"]) ?? 0n, identity_key: identityKey }, obligors: resolved, matchOnIdentity: match, ...(match ? { priorIdentityKeys: priorKeys } : {}), supersedes: supersedesOf(i) });
        assertLanded("writeDuLiability", "du_liabilities", id, w.id);
      });
      ctx.events.append({ type: "du.graph.liability.written", applicationId: app, aggregate: { kind: "du_liabilities", id }, actor: ctx.actor, payload: { application_id: app, liability_id: id, liability_type: l["liability_type"], obligors: obligors.map((o) => o.ref), secured_by_owned_property_id: l["secured_by_owned_property_id"] ?? null, match_on_identity: match, matched: found !== null, identity_key: identityKey, supersedes: supersedesOf(i)?.id ?? null, ...citation(i) } });
      return { liability_id: id, application_id: app, liability_type: l["liability_type"], obligors: obligors.map((o) => o.ref), match_on_identity: match, matched: found !== null, identity_key: identityKey };
    }), decision: () => null },

  { name: "writeDuExpense", kind: "write", ruleSetVersion: RULE_SET, guardrails: [owned("payers"), NO_DISPUTED_ENDPOINT],
    handler: compute((i, ctx, rt) => {
      const app = appOf(i, ctx); const defer = deferOf(rt); const e = row(i["expense"]); need(e as ToolInput, "expense_type");
      const payers = ownerRefs(i, "payers"); const id = str(i, "expense_id") || (typeof e["id"] === "string" ? String(e["id"]) : randomUUID());
      defer(async (q) => { await writeExpense(q, { expense: { ...(e as DuExpenseRow), id, application_id: app, monthly_payment_cents: optCents(e["monthly_payment_cents"]) ?? 0n }, payers: await resolveOwners(q, app, payers) }); });
      ctx.events.append({ type: "du.graph.expense.written", applicationId: app, aggregate: { kind: "du_expenses", id }, actor: ctx.actor, payload: { application_id: app, expense_id: id, expense_type: e["expense_type"], payers: payers.map((o) => o.ref), ...citation(i) } });
      return { expense_id: id, application_id: app, expense_type: e["expense_type"], payers: payers.map((o) => o.ref) };
    }), decision: () => null },

  { name: "writeDuOwnedProperty", kind: "write", ruleSetVersion: RULE_SET, guardrails: [owned("owners"), NO_DERIVED_PROPERTY_FIELDS, NO_DISPUTED_ENDPOINT],
    handler: compute(async (i, ctx, rt) => {
      const app = appOf(i, ctx); const defer = deferOf(rt); const db = dbOf(rt); const p = row(i["property"]); need(p as ToolInput, "disposition");
      const owners = ownerRefs(i, "owners"); const mintedAsset = str(i, "asset_id") || randomUUID();
      const match = flag(i, "match_on_identity"); const identityKey = str(i, "identity_key") || `${MANUAL_PREFIX}${mintedAsset}`; const priorKeys = list(i["prior_identity_keys"]).map(String);
      // Lookup-before, as writeDuAsset: the OWNED_PROPERTY asset a re-run names (by its identity key) and the 3a row already hanging off it — the ids reported are theirs.
      const resolved = await resolveOwners(db, app, owners);
      const found = match ? await lookupByIdentity(db, "du_assets", app, [identityKey, ...priorKeys]) : null;
      const assetId = found?.id ?? mintedAsset;
      const existing = (await db.query<{ id: string }>(`SELECT id FROM du_owned_properties WHERE asset_id = $1`, [assetId]))[0];
      const propertyId = existing?.id ?? (typeof p["id"] === "string" ? String(p["id"]) : randomUUID());
      defer(async (q) => {
        const w = await writeOwnedProperty(q, { applicationId: app, assetId, identityKey, property: { ...(p as DuOwnedPropertyRow), id: propertyId }, owners: resolved, matchOnIdentity: match, priorIdentityKeys: priorKeys, sourceVerificationId: (i["source_verification_id"] as string | null | undefined) ?? null });
        assertLanded("writeDuOwnedProperty", "du_assets", assetId, w.assetId); assertLanded("writeDuOwnedProperty", "du_owned_properties", propertyId, w.propertyId);
      });
      ctx.events.append({ type: "du.graph.owned_property.written", applicationId: app, aggregate: { kind: "du_owned_properties", id: propertyId }, actor: ctx.actor, payload: { application_id: app, asset_id: assetId, owned_property_id: propertyId, disposition: p["disposition"], is_subject: p["is_subject"] === true, owners: owners.map((o) => o.ref), match_on_identity: match, matched: found !== null, identity_key: identityKey, ...citation(i) } });
      return { asset_id: assetId, owned_property_id: propertyId, application_id: app, disposition: p["disposition"], owners: owners.map((o) => o.ref), match_on_identity: match, matched: found !== null, identity_key: identityKey };
    }), decision: () => null },

  { name: "linkOwner", kind: "write", ruleSetVersion: RULE_SET, guardrails: [NO_DISPUTED_ENDPOINT],
    handler: compute((i, ctx, rt) => {
      const app = appOf(i, ctx); const defer = deferOf(rt); need(i, "kind", "row_id", "application_borrower_id"); const kind = str(i, "kind") as OwnedKind; if (!["asset", "liability", "expense"].includes(kind)) throw new RangeError("kind is one of asset/liability/expense");
      const rowId = str(i, "row_id"); const ref = str(i, "application_borrower_id"); const role = str(i, "role") || undefined;
      defer(async (q) => { await linkOwner(q, kind, rowId, { applicationBorrowerId: await resolveBorrowerEdge(q, app, ref), ...(role ? { role } : {}) }); });
      ctx.events.append({ type: "du.graph.owner.linked", applicationId: app, aggregate: { kind: `du_${kind}_parties`, id: rowId }, actor: ctx.actor, payload: { application_id: app, kind, row_id: rowId, application_borrower_id: ref, role: role ?? null, ...citation(i) } });
      return { kind, row_id: rowId, application_borrower_id: ref, linked: true };
    }), decision: () => null },

  { name: "unlinkOwner", kind: "write", ruleSetVersion: RULE_SET, guardrails: [NO_DISPUTED_ENDPOINT],
    handler: compute((i, ctx, rt) => {
      const app = appOf(i, ctx); const defer = deferOf(rt); need(i, "kind", "row_id", "application_borrower_id"); const kind = str(i, "kind") as OwnedKind; if (!["asset", "liability", "expense"].includes(kind)) throw new RangeError("kind is one of asset/liability/expense");
      const rowId = str(i, "row_id"); const ref = str(i, "application_borrower_id");
      defer(async (q) => { await unlinkOwner(q, kind, rowId, await resolveBorrowerEdge(q, app, ref)); });
      ctx.events.append({ type: "du.graph.owner.unlinked", applicationId: app, aggregate: { kind: `du_${kind}_parties`, id: rowId }, actor: ctx.actor, payload: { application_id: app, kind, row_id: rowId, application_borrower_id: ref, ...citation(i) } });
      return { kind, row_id: rowId, application_borrower_id: ref, unlinked: true, note: "the database refuses the COMMIT with DU_GRAPH_ORPHAN when this was a live row's last owner" };
    }), decision: () => null },

  // A HUMAN act of the declaring borrower: agents may never execute it (HUMAN_ONLY), the role is the borrower's own, and the actor on the row is the command's.
  { name: "assertDeclarations", kind: "write", ruleSetVersion: RULE_SET, humanOnly: true, humanRoles: ["borrower"], guardrails: [SELF_ATTESTED, ACTOR_FROM_CONTEXT, NEVER_DERIVED],
    handler: compute((i, ctx, rt) => {
      const app = appOf(i, ctx); const defer = deferOf(rt); const answers = obj(i["answers"]);
      const missing = DU_DECLARATION_ANSWERS.filter((k) => k !== "special_borrower_seller_relationship" && k !== "party_to_lawsuit" && answers[k] !== "Yes" && answers[k] !== "No");
      if (missing.length) throw new RangeError(`answers must carry Yes/No for ${missing.join(", ")} (URLA section 5: a half-answered declaration never reaches the file)`);
      const follow: P = {}; const given = obj(i["follow_ups"]);
      for (const k of DU_DECLARATION_FOLLOW_UPS) if (given[k] !== undefined) follow[k] = k.endsWith("_cents") ? optCents(given[k]) : given[k];
      if (typeof i["bankruptcy_explanation"] === "string") follow["bankruptcy_explanation"] = i["bankruptcy_explanation"];
      const chapters = list(i["bankruptcy_chapters"]).map(String); const ref = str(i, "application_borrower_id"); const actor = ctx.actor;
      defer(async (q) => {
        // The borrower's own edge: the one named, else the one whose party is the signed-in actor — never another party's.
        const edge = ref ? await resolveBorrowerEdge(q, app, ref) : (await q.query<{ id: string }>(`SELECT id FROM application_borrowers WHERE application_id = $1 AND party_id = $2::uuid ORDER BY created_at, id LIMIT 1`, [app, actor.id]))[0]?.id;
        if (!edge) throw new RangeError(`no application_borrowers row on ${app} for party ${actor.id}`);
        await assertDeclarations(q, { applicationBorrowerId: edge, actor, answers: answers as never, followUps: follow, bankruptcyChapters: chapters, assertedAt: ctx.now });
      });
      ctx.events.append({ type: "du.graph.declaration.asserted", applicationId: app, aggregate: { kind: "du_declarations", id: ref || actor.id }, actor, payload: { application_id: app, application_borrower_id: ref || null, party_id: actor.id, bankruptcy: answers["bankruptcy"], bankruptcy_chapters: chapters, has_explanation: typeof follow["bankruptcy_explanation"] === "string" && follow["bankruptcy_explanation"] !== "", answers: Object.fromEntries(DU_DECLARATION_ANSWERS.map((k) => [k, answers[k] ?? null])), ...citation(i) } });
      return { application_id: app, application_borrower_id: ref || null, asserted_by: { kind: actor.kind, id: actor.id, role: actor.role ?? null }, bankruptcy: answers["bankruptcy"], bankruptcy_chapters: chapters, has_explanation: typeof follow["bankruptcy_explanation"] === "string" && follow["bankruptcy_explanation"] !== "" };
    }), decision: () => null },

  { name: "writeResidence", kind: "write", ruleSetVersion: RULE_SET, guardrails: [NO_DISPUTED_ENDPOINT],
    handler: compute((i, ctx, rt) => {
      const app = appOf(i, ctx); const defer = deferOf(rt); need(i, "application_borrower_id"); const r = row(i["residence"]); need(r as ToolInput, "residency_type", "residency_basis");
      if (r["duration_months"] === undefined || r["duration_months"] === null) throw new RangeError("residence.duration_months is required");
      const ref = str(i, "application_borrower_id"); const id = typeof r["id"] === "string" ? String(r["id"]) : randomUUID();
      defer(async (q) => { await writeResidence(q, await resolveBorrowerEdge(q, app, ref), { ...(r as DuResidenceRow), id, residency_type: String(r["residency_type"]), residency_basis: String(r["residency_basis"]), duration_months: Number(r["duration_months"]) }); });
      ctx.events.append({ type: "du.graph.residence.written", applicationId: app, aggregate: { kind: "du_residences", id }, actor: ctx.actor, payload: { application_id: app, application_borrower_id: ref, residency_type: r["residency_type"], residency_basis: r["residency_basis"], monthly_rent_cents: r["monthly_rent_cents"] ?? null, duration_months: Number(r["duration_months"]), ...citation(i) } });
      return { residence_id: id, application_id: app, application_borrower_id: ref, residency_type: r["residency_type"], residency_basis: r["residency_basis"] };
    }), decision: () => null },

  { name: "appendBorrower", kind: "write", ruleSetVersion: RULE_SET, guardrails: [NO_DISPUTED_ENDPOINT],
    handler: compute((i, ctx, rt) => {
      const app = appOf(i, ctx); const defer = deferOf(rt); need(i, "legal_name"); const id = str(i, "application_borrower_id") || randomUUID(); const role = str(i, "borrower_role") || "co_borrower";
      const ordinal = i["borrower_ordinal"] === undefined || i["borrower_ordinal"] === null ? null : Number(i["borrower_ordinal"]);
      defer(async (q) => { await appendBorrower(q, { id, applicationId: app, legalName: str(i, "legal_name"), borrowerRole: role, partyId: str(i, "party_id") || null, borrowerId: str(i, "borrower_id") || null, contact: obj(i["contact"]), borrowerOrdinal: ordinal }); });
      ctx.events.append({ type: "du.graph.borrower.appended", applicationId: app, aggregate: { kind: "application_borrowers", id }, actor: ctx.actor, payload: { application_id: app, application_borrower_id: id, borrower_role: role, borrower_ordinal: ordinal, party_id: str(i, "party_id") || null, ...citation(i) } });
      return { application_borrower_id: id, application_id: app, borrower_role: role, borrower_ordinal: ordinal, note: ordinal === null ? "the database allocates the position (1 for the borrower role, else the smallest free from 2) at COMMIT" : "a stated position; the unique index refuses a collision" };
    }), decision: () => null },

  { name: "linkJointCreditReport", kind: "write", ruleSetVersion: RULE_SET, guardrails: [NO_DISPUTED_ENDPOINT],
    handler: compute((i, ctx, rt) => {
      const app = appOf(i, ctx); const defer = deferOf(rt);
      const primary = str(i, "primary") || str(i, "to") || str(i, "to_application_borrower_id"); const additional = [...list(i["additional"]).map(String), ...(str(i, "from") ? [str(i, "from")] : []), ...(str(i, "from_application_borrower_id") ? [str(i, "from_application_borrower_id")] : [])].filter(Boolean);
      if (!primary) throw new RangeError("primary (the group's primary borrower) is required"); if (!additional.length) throw new RangeError("additional[] (the borrowers sharing the primary's report) is required");
      if (additional.includes(primary)) throw new RangeError("a borrower does not share a joint credit report with themselves");
      defer(async (q) => { const to = await resolveBorrowerEdge(q, app, primary); for (const a of additional) await linkJointCreditReport(q, app, await resolveBorrowerEdge(q, app, a), to); });
      ctx.events.append({ type: "du.graph.joint_credit.linked", applicationId: app, actor: ctx.actor, payload: { application_id: app, primary, additional, credit_report_id: str(i, "credit_report_id") || null, ...citation(i) } });
      return { application_id: app, primary, additional, links: additional.length };
    }), decision: () => null },

  { name: "readDuGraph", kind: "read", handler: compute(async (i, ctx, rt) => readDuGraph(dbOf(rt), appOf(i, ctx))) },
]);
