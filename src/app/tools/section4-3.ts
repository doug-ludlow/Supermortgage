/**
 * §4.3 process-owned tools — additional bus tools for 4.3 defined with `defineTools("4.3", <agent>, defs)`
 * from ../tools.ts (the section's original tools stay in ./section04.ts). Every tool string in TOOLS_4_3 must be one
 * spec/registry/agents.json names for 4.3; src/app/tools.test.ts refuses the rest. Spread by ./index.ts.
 *
 * CONTINUITY_COMMANDS_4_3 are the `borrower-comms` case commands the 4.3 Integrations / rule paragraphs describe but do
 * not list as tool strings (spread into SECTION_04_CASE_COMMANDS by ./section04.ts, so the harness and the ops console
 * bind them on the same bus):
 *  - chat.message.receive — the chat widget / secure-message ingestion (ops-4-3.receiveInboundMessage): the first
 *    message of a session appends `chat.session.started` (FNMA_A4_2_1_04_CHAT_5MIN trigger); a request for a
 *    foreclosure-prevention alternative appends `lossmit.assistance.requested{state, s2924_15}`
 *    (CA_CIV_2923_7_SPOC_ASSIGN_PROMPT trigger, rule 4 / 4.3-T7).
 *  - chat.respond — the session's response (ops-4-3.sendChatResponse): `chat.first_response.sent` satisfies
 *    FNMA_A4_2_1_04_CHAT_5MIN.
 *  - continuity.permanent_agreement.record — the 12.x agreement taking effect (ops-4-3.permanentAgreementEffective):
 *    only a *permanent* agreement appends `lossmit.permanent_agreement.effective` and opens
 *    REGX_1024_40A2_RELEASE_2_PERMANENT_PAYMENTS (rule 3: trial-period payments never count; 4.3-T6).
 */
import { defineTools, compute, never, str, num, flag, type ToolDef } from "../tools.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { receiveInboundMessage, sendChatResponse, permanentAgreementEffective, type InboundChannel, type AgreementRecord } from "../../domain/servicing-requests/ops-4-3.ts";

export const TOOLS_4_3: readonly ToolDef[] = [];

export const CONTINUITY_COMMANDS_4_3: readonly ToolDef[] = defineTools("4.3", "borrower-comms", [
  { name: "chat.message.receive", kind: "write", handler: compute((i, ctx) => {
      const r = receiveInboundMessage(ctx.events, ctx.loanId, { channel: (str(i, "channel") || "chat") as InboundChannel, ...(str(i, "session_id") ? { session_id: str(i, "session_id") } : {}), text: str(i, "text"), received_at: str(i, "received_at") || ctx.now, state: str(i, "state"), ...(typeof i.s2924_15 === "boolean" ? { s2924_15: i.s2924_15 } : {}), borrower_id: typeof i.borrower_id === "string" ? i.borrower_id : null }, ctx.actor);
      return { session_started: r.session_started !== null, session_id: r.session_started?.payload.session_id ?? (str(i, "session_id") || null), first_response_due_at: r.session_started?.payload.first_response_due_at ?? null, assistance_requested: r.assistance !== null, spoc_required: r.spoc_required, assign_by: r.assign_by };
    }),
    guardrails: [never("MESSAGE_TEXT", "4.3 inputs: `contact.inbound` — an empty message is not an inquiry", (i) => !str(i, "text").trim(), "text required")] },
  { name: "chat.respond", kind: "write", handler: compute((i, ctx) => { const e = sendChatResponse(ctx.events, ctx.loanId, { session_id: str(i, "session_id"), text: str(i, "text"), sent_at: str(i, "sent_at") || ctx.now }, ctx.actor); return { session_id: e.payload.session_id, first: e.payload.first, response_seconds: e.payload.response_seconds }; }),
    guardrails: [never("RESPONSE_TEXT", "A4-2.1-04: 'live chat initiated ≤5 minutes' — the response is a message to the borrower", (i) => !str(i, "text").trim(), "a chat response needs text"),
      never("FACTS_FROM_VIEW", "4.3 rule 5: the AI may not state a deadline or option not present in lossmit_facts", (i) => flag(i, "stated_deadline_not_in_view") || flag(i, "stated_option_not_in_view"), "a stated deadline/option is not in lossmit_facts")] },
  { name: "continuity.permanent_agreement.record", kind: "write", handler: compute((i, ctx, rt) => { const e = permanentAgreementEffective(rt, ctx, { agreement_id: str(i, "agreement_id"), kind: str(i, "kind") as AgreementRecord["kind"], effective_on: D(str(i, "effective_on")), ...(i.payment_due_day !== undefined ? { payment_due_day: num(i, "payment_due_day") } : {}), ...(i.grace_days !== undefined ? { grace_days: num(i, "grace_days") } : {}) }); return { agreement_id: e.payload.agreement_id, effective_on: e.payload.effective_on, episode_id: e.payload.episode_id, gate: "REGX_1024_40A2_RELEASE_2_PERMANENT_PAYMENTS" }; }),
    guardrails: [never("PERMANENT_ONLY", "4.3 rule 3: 'Trial-period payments do not count (the agreement must be *permanent*)'; §1024.40(a)(2) 'permanent loss mitigation agreement'", (i) => str(i, "kind") !== "permanent", "a trial period plan or forbearance never opens the release gate"),
      never("AGREEMENT_ID", "4.3 data model: `continuity_episodes.permanent_agreement_id`", (i) => !str(i, "agreement_id"), "agreement_id required")] },
]);
