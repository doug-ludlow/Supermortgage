/**
 * §34.5 process-owned tools — the `security-records` agent's `portal.home` and `directory.list` (spec/sections/34-operator-portal/
 * 34-5-*.md "AI agent design"; `directory.counts`, `pipeline.list`, `loans.list` and `notice.read` follow in the later increments),
 * defined with `defineTools("34.5", "security-records", defs)` and spread by ./index.ts. Every tool string is one
 * spec/registry/agents.json names for 34.5. Thin bus wrappers over src/runtime/portal/home.ts and src/runtime/directory/list.ts:
 * every tool is a read that projects the record for the CALLER'S ROLE, writes its own look event (and 34.1's log row through the
 * console) and answers; the agent proposes nothing and never acts.
 *
 *   portal.home       read   rule 2: the clocks due and breached, the open escalations by role, the work waiting for every role the
 *                            account holds as one list with the role on each row, the dead-letter and held-notice counts, the FAKE
 *                            roster; the admin tiles for an admin; `portal.home.viewed{staff_user_id, roles}`. The held roles are the
 *                            actor's `staff_users` row — never the input's.
 *   directory.list    read   rules 4–9: one page of borrower parties, masked as the search is; `directory.listed{staff_user_id,
 *                            filters_hash, results}`; LIST_VOLUME watches the paging (list.ts).
 *
 * Guardrails (the paragraph's list): ROLE_MASK (the projection is masked for the role before it leaves the tool — an unmasked or raw
 * ask outside compliance / officer is refused, and the list is masked regardless), LOG_EVERY_LOOK (one log row and one event per
 * page; the log cannot be switched off), LIST_VOLUME (rule 8 — the control is the escalation the logged wrapper opens, never a
 * lock-out: the guardrail refuses nothing), NO_FULL_SSN, NO_SECRETS (hashes, tokens, vendor payloads never projected), READ_ONLY
 * (no input may carry a write), NO_MONEY_FIELD (no figure is computed or written: an amount, a waiver or a posting in the input is
 * refused — the waiver is the owning section's officer tool), NO_PII_IN_LOG (an ask to log the filters in clear is refused: ids,
 * hashes and the role only). The actor is the bus actor (34.1 rule 3): `staff_user_id` is never read from the input and a
 * `session_id` counts only as the actor's own open staff session (34.2's staffOf).
 */
import { defineTools, compute, guard, never, str, flag, PortUnavailable, type ToolDef, type ToolRuntime } from "../tools.ts";
import type { Runtime } from "../../runtime/app.ts";
import { DIRECTORY_ROLES, UNMASK_ROLES } from "../../runtime/directory/mask.ts";
import { directoryListLogged, LIST_VOLUME_PAGES_PER_DAY, LIST_VOLUME_ROWS_PER_DAY } from "../../runtime/directory/list.ts";
import { HOME_ROLES, portalHomeLogged } from "../../runtime/portal/home.ts";
import { staffOf } from "./section34-2.ts";

const PROCESS_34_5 = "34.5"; const AGENT = "security-records";
const runtimeOf = (rt: ToolRuntime): Runtime => { const r = rt.services["runtime"] as Runtime | undefined; if (!r) throw new PortUnavailable("service:runtime"); return r; };
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
const asks = (i: Record<string, unknown>, keys: ReadonlySet<string>): boolean => Object.keys(i).some((k) => keys.has(k) && i[k] !== false && i[k] !== null && i[k] !== undefined && i[k] !== "");

// ───────── guardrails ─────────

const UNMASK_ASKS = ["unmasked", "full", "raw", "unmask_all", "show_pii", "plain"];
const ROLE_MASK = guard("ROLE_MASK", "34.5 rule 7 / guardrails ('the projection is masked for the role before it leaves the tool') / 34.2 rule 2", (i, ctx) => {
  if (!(UNMASK_ASKS.some((k) => flag(i, k)) || list(i["unmask"]).length > 0)) return undefined;
  return ctx.actor.kind === "human" && !!ctx.actor.role && UNMASK_ROLES.includes(ctx.actor.role) ? "a list is never unmasked: unmasking stays per person, per case, for 15 minutes with a reason, on the account page (34.5 rule 7)" : `an unmasked projection needs ${UNMASK_ROLES.join(" or ")}; the ${ctx.actor.kind}${ctx.actor.role ? ` ${ctx.actor.role}` : ""} reads the masked view`;
});
const SSN_ASKS = new Set(["ssn", "full_ssn", "include_ssn", "tin", "full_tin", "include_tin", "ssn_full", "tin_encrypted"]);
const NO_FULL_SSN = never("NO_FULL_SSN", "34.5 rule 7 ('never an SSN, a date of birth') / guardrails / GLBA §1016.13", (i) => asks(i, SSN_ASKS), "no list carries a full SSN or TIN; identity shows the last four under an unmask on the account page only");
const SECRET_ASKS = new Set(["include_tokens", "tokens", "token_hash", "include_hashes", "hashes", "password_hash", "credential_hash", "include_payloads", "vendor_payloads", "vendor_payload", "include_raw", "raw_tool_inputs", "tool_inputs", "context_hash", "secrets"]);
const NO_SECRETS = never("NO_SECRETS", "34.5 guardrails ('hashes, tokens, vendor payloads never projected') / 34.2 rule 2", (i) => asks(i, SECRET_ASKS), "hashes, tokens, vendor payloads and the model's raw inputs are never projected");
const LOG_ASKS = ["unlogged", "no_log", "quiet", "silent", "skip_log", "without_log"];
const LOG_EVERY_LOOK = never("LOG_EVERY_LOOK", "34.5 rule 7 ('Every page of a list is one logged look') / guardrails ('one log row and one event per page, filters hashed')", (i) => LOG_ASKS.some((k) => flag(i, k)), "every look is logged (directory.listed / portal.home.viewed and 34.1's staff_actions row); the log cannot be switched off");
const PII_LOG_ASKS = new Set(["log_filters", "log_query", "log_text", "unhashed_log", "plain_log", "log_plain"]);
const NO_PII_IN_LOG = never("NO_PII_IN_LOG", "34.5 rule 7 ('a name filter is personal data, so it is never logged in clear') / guardrails ('ids, hashes and the role only')", (i) => asks(i, PII_LOG_ASKS), "the log carries the filters as their hash, the person's id and the role — never a filter text");
const WRITE_KEYS = new Set(["changes", "update", "set", "delete", "merge", "patch", "edit", "write", "correct", "amend"]);
const READ_ONLY = never("READ_ONLY", "34.5 rule 15 ('Nothing computed, nothing written, nothing sent') / guardrails", (i) => i.op === "write" || asks(i, WRITE_KEYS), "the portal projects; an action on a record is the owning section's command with the staff actor (34.1 rule 3)");
const MONEY_KEYS = new Set(["amount", "amount_cents", "cents", "waive", "waiver", "waive_cents", "refund", "refund_cents", "post", "posting", "payment", "payment_cents", "fee_cents", "credit_cents", "debit_cents", "adjustment_cents"]);
const NO_MONEY_FIELD = never("NO_MONEY_FIELD", "34.5 rule 11 / rule 15 ('No money figure is computed here') / guardrails ('the waiver is the owning section's officer tool')", (i) => asks(i, MONEY_KEYS), "no figure is computed or written by a portal read; a waiver, a refund or a posting is the owning section's officer tool through the bus route");
/** Rule 8: the control is the escalation the logged wrapper opens past 20 pages or 1,000 rows a day — the lists keep answering, so the guardrail refuses nothing. */
const LIST_VOLUME = guard("LIST_VOLUME", `34.5 rule 8 ('more than ${LIST_VOLUME_PAGES_PER_DAY} pages or more than ${LIST_VOLUME_ROWS_PER_DAY} rows read by one person in one day … opens one compliance escalation … The lists keep answering — the control is the escalation, not a lock-out')`, () => undefined);
const READ_GUARDS = [ROLE_MASK, NO_FULL_SSN, NO_SECRETS, LOG_EVERY_LOOK, NO_PII_IN_LOG, READ_ONLY, NO_MONEY_FIELD];

// ───────── the tools ─────────

export const TOOLS_34_5: readonly ToolDef[] = defineTools(PROCESS_34_5, AGENT, [
  { name: "portal.home", kind: "read", humanRoles: HOME_ROLES, guardrails: READ_GUARDS,
    handler: compute(async (i, ctx, rt) => { const runtime = runtimeOf(rt); const s = await staffOf(i, ctx, runtime);
      // the roles the session holds are the account's row (34.1 rule 2), read here — never the input's; an agent holds none and reads an empty Home
      const roles = ctx.actor.kind === "human" ? ((await runtime.db.query<{ roles: string[] }>(`SELECT roles FROM staff_users WHERE id = $1::uuid AND status = 'active'`, [s.staff_user_id]))[0]?.roles ?? []) : [];
      return portalHomeLogged(runtime, { acted_as: ctx.actor.role ?? "", roles, kind: str(i, "kind") || null, now: ctx.now }, s, ctx.actor); }) },

  { name: "directory.list", kind: "read", humanRoles: DIRECTORY_ROLES, guardrails: [...READ_GUARDS, LIST_VOLUME],
    handler: compute(async (i, ctx, rt) => { const runtime = runtimeOf(rt); const s = await staffOf(i, ctx, runtime); const { session_id: _s, ...filters } = i; return directoryListLogged(runtime, filters, s, ctx.actor); }) },
]);
export const PORTAL_TOOLS = TOOLS_34_5.map((t) => t.name);
