// 20.2 Solicitation, marketing, and consent compliance for outbound refinance offers and organic acquisition
// spec/sections/20-refinance-triggers-solicitation-lead-intake-and-pricing/20-2-solicitation-marketing-and-consent-compliance-for-outbound-r.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { TOOLS_20_2 } from "../../app/tools/section20-2.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { NoticeService } from "../../notices/service.ts";
import { buildRegistry } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist, publishCheck } from "../../notices/checklist.ts";
import { VERSIONS_20_2, REFI_OFFER_SOURCE, REFI_OFFER_SAMPLE, AI_VOICE_IDENT_SOURCE, AI_VOICE_IDENT_SAMPLE } from "../../notices/authored/section20-2.ts";
import { levelPayment, ratePercent } from "../../kernel/money/cents.ts";
import { type Campaign, type Creative, type MarketingConsent, type TouchFacts, type Channel, type DncScrub, type Suppression,
  captureMarketingConsent, expireInterimConsent, pewcValid, findPewc, withdrawConsent, ebrBasis, completeDncScrub, scrubInForce, quietHoursCheck, humanDialSlot, runContentChecklist, checklistFailures, validateVariablesSchema, renderCreative, noInvestorReference,
  createCampaign, approveCreative, approveCampaign, launchCampaign, supersedeCreative, verifyMapArchive, prescreenNoticeGate, isRefusal, recordSuppression, receiveSmsStop, marketingContentPresent, checkGates, scheduleTouch, placeCall, DNC_SCRUB_VALIDITY_DAYS, SMS_STOP_CONFIRMATION_TEXT } from "./ops-20-2.ts";

const AGENT: Actor = { kind: "agent", id: "intake" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const MLO: Actor = { kind: "human", id: "u-mlo-team", role: "mlo_of_record" };
const PARTNER = "[Partner]";
const PHOENIX = "America/Phoenix";
const NEW_YORK = "America/New_York";
const CELL = "+16025550142";
const MST = (date: string, hhmm: string): string => new Date(`${date}T${hhmm}:00-07:00`).toISOString();
const ET = (date: string, hhmm: string): string => new Date(`${date}T${hhmm}:00-04:00`).toISOString();
const ofType = (events: MemoryEventStore, type: string): DomainEvent[] => events.all().filter((e) => e.type === type);

const EMAIL_TEXT = `${PARTNER}, NMLSR ID 123456, is your current lender; Supermortgage services your loan for ${PARTNER}. Your current rate 7.000% → offered rate 6.125% (6.155% annual percentage rate (APR)); 360 monthly principal-and-interest payments of $3,402.62; fixed rate for the full term — the annual percentage rate will not increase. Payments do not include amounts for taxes and insurance premiums, and your actual payment obligation will be greater. No lender fees and no third-party closing costs charged to you; those costs are paid by Supermortgage and reflected in the rate offered. This is not a commitment to lend. Rates change daily. This is an advertisement from ${PARTNER}; unsubscribe: https://portal.example.com/u; ${PARTNER}, 100 Example Way, Anytown, AZ 85000.`;
const VOICE_TEXT = `This is an automated call from Supermortgage on behalf of ${PARTNER}, your mortgage lender, about a refinance offer. To stop these calls, press 1 or say "do not call" at any time. You can reach ${PARTNER} through Supermortgage at (800) 555-0100. You are speaking with an automated assistant, not a person; say "representative" at any time to reach a person. ${PARTNER}, NMLSR ID 123456.`;
const HUMAN_OPENING = `This is a sales call from Supermortgage on behalf of ${PARTNER}, your mortgage lender, about a refinance offer on your mortgage loan.`;
const ORGANIC_MAIL_TEXT = `${PARTNER}, NMLSR ID 123456, offers refinance and purchase mortgage loans; Supermortgage services loans for ${PARTNER}. This is not a commitment to lend.`;
const SMS_TEXT = `${PARTNER} (NMLSR ID 123456) via Supermortgage: a refinance option may lower your monthly cost. Reply STOP to opt out. This is not a commitment to lend.`;
const SHEET = { sheet_rates_pct: ["6.125", "6.250", "6.000"], optout_offer_seconds: 2 };

/** The 20.2 tools on the bus over the overridden registry (20.2 rows), the Notice Registry and the escalation service. */
function harness(nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["20.2"] });
  const decisions: DecisionInput[] = [];
  const uow: UowContext = { loanId: "", events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const noticeReg = buildRegistry(); for (const v of VERSIONS_20_2) noticeReg.publish(v.templateCode, v.version, "counsel", "2026-09-01T00:00:00.000Z", publishCheck);
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, notices: new NoticeService({ registry: noticeReg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() }), ports: {} };
  const agents = new AgentRegistry(); const cmds = bindTools(rt, agents, TOOLS_20_2); const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("20.2", name))!, actor, input, uow)).output as Record<string, unknown>;
  const put = (kind: string, id: string, data: object) => rt.store.put(kind, id, data as Record<string, unknown>, AGENT, clock.now());
  return { rt, uow, events, timers, run, put, at: (iso: string) => clock.set(iso), decisions };
}
type H = ReturnType<typeof harness>;
/** An approved, live refi_trigger_outbound campaign with an approved creative per channel (partner officer's approvals). */
function seedCampaign(h: H, channels: Channel[] = ["email", "portal", "ai_voice", "human_voice", "sms"], kind: Campaign["kind"] = "refi_trigger_outbound"): { campaign: Campaign; creatives: Creative[] } {
  const mail = kind === "prescreen" ? ORGANIC_MAIL_TEXT : EMAIL_TEXT;   // an organic/prescreen creative never claims to be the current lender (MAP (o); §1026.24(i)(4))
  const texts: Record<Channel, string> = { email: EMAIL_TEXT, portal: EMAIL_TEXT, mail, ai_voice: VOICE_TEXT, human_voice: VOICE_TEXT, sms: SMS_TEXT };
  const creatives = channels.map((channel): Creative => ({ creative_id: `cr-${channel}`, campaign_id: "camp-refi-2026-10", channel, template_code: channel === "ai_voice" || channel === "human_voice" ? "NTC_TCPA_64_1200_B_AI_VOICE_IDENT" : "NTC_REGZ_1026_24_REFI_OFFER", template_version: "1.0.0", content_hash: null, rate_sheet_id: channel === "email" || channel === "portal" ? "rs-2026-10-02" : null, variables_schema: ["borrower_name", "offered_rate_pct"], checklists: null, status: "draft", approved_by: null, approved_at: null, superseded_by: null, prompt_version: channel === "ai_voice" ? "voice-prompt-v3" : null, disseminated_from: null, disseminated_to: null, rendered_text: texts[channel] }));
  const campaign = createCampaign({ campaign_id: "camp-refi-2026-10", partner_id: "partner-1", program_id: "sim-2026", kind, channels, selection_rule_set: "sm.refi_trigger.2026.v1", creative_ids: creatives.map((c) => c.creative_id) });
  for (const c of creatives) { const r = approveCreative(h.events, c, { approved_by: "human:u-officer", at: ET("2026-10-01", "12:00"), checklist_input: SHEET, campaign_kind: kind }, OFFICER); assert.ok(!isRefusal(r), `creative ${c.creative_id}: ${isRefusal(r) ? r.detail : ""}`); h.put("marketing_creatives", c.creative_id, c); }
  if (kind !== "prescreen") { assert.ok(!isRefusal(approveCampaign(h.events, campaign, { approved_by: "human:u-officer", at: ET("2026-10-01", "12:30"), creatives }, OFFICER))); launchCampaign(h.events, campaign, ET("2026-10-01", "13:00")); }
  h.put("marketing_campaigns", campaign.campaign_id, campaign);
  return { campaign, creatives };
}
const INFORMATIONAL: MarketingConsent = { consent_id: "c-info-voice", party_id: "party-1", loan_id: "loan-1", kind: "tcpa_voice", purpose: "informational", phone_number: CELL, status: "active", written_consent: false, pewc_elements: null, signature_kind: null, disclosure_version: null, disclosure_text_hash: null, captured_at: ET("2025-10-14", "10:00"), written_confirmation_due_at: null, national_dnc_written_permission: false, evidence: { captured_via: "portal_enrollment" } };
const PEWC_TEXT = `Yes, ${PARTNER} and Supermortgage on its behalf may call or text me at ${CELL} using an automated system or an artificial or prerecorded voice about refinance offers. I understand consent is not a condition of any purchase or loan.`;
const scrub0928 = (events: MemoryEventStore): DncScrub => completeDncScrub(events, { scrub_id: "scrub-2026-09-28", obtained_at: ET("2026-09-28", "06:00"), numbers_checked: 12_000, hits: 340, file_hash: "sha256:0928" }).scrub;
/** The same registry version as a plain fact (no event) for touch facts. */
const SCRUB_0928: DncScrub = { scrub_id: "scrub-2026-09-28", source: "ftc_registry", registry_version_obtained_at: ET("2026-09-28", "06:00"), obtained_on: D("2026-09-28"), valid_until: D("2026-10-29"), numbers_checked: 12_000, hits: 340, file_hash: "sha256:0928" };
/** Touch facts for the fixture borrower (Phoenix; loan-1; email verified; cell on the servicing account). */
const facts = (_h: H, creative: Creative | null, channel: Channel, queued_at: string, over: Partial<TouchFacts> = {}, touch: Partial<TouchFacts["touch"]> = {}): TouchFacts => ({
  touch: { touch_id: `t-${channel}-${queued_at}`, campaign_id: "camp-refi-2026-10", campaign_kind: "refi_trigger_outbound", creative_id: creative?.creative_id ?? `cr-${channel}`, channel, party_id: "party-1", loan_id: "loan-1", opportunity_id: "opp-1", destination: channel === "email" ? "borrower@example.com" : CELL, destination_id: channel === "email" ? "email-1" : "phone-1", line_type: channel === "email" || channel === "portal" ? null : "mobile", queued_at, time_zones: [PHOENIX], state: "AZ", ...touch },
  partner_name: PARTNER, consents: [INFORMATIONAL], scrubs: [SCRUB_0928], on_national_registry: false, ebr: { last_transaction_on: D("2026-10-01") }, suppressions: [], creative, rendered_text: creative?.rendered_text ?? null, rate_sheet_current: true, flags: { prescreen_enabled: false }, ...over });

test("20.2-T1: Given a cell number with informational `tcpa_voice` consent only, when an `ai_voice` marketing touch is queued on 2026-10-02, then `TCPA_64_1200_A2_PEWC_GATE` fails, the touch is `suppressed{no_pewc}`, and a `human_voice` click-to-dial touch is scheduled at 10:30 America/Phoenix.", async () => {
  const h = harness(MST("2026-10-02", "09:05")); const { creatives } = seedCampaign(h);
  const scrub = scrub0928(h.events);
  const plan = await h.run("planChannels", { campaign_id: "camp-refi-2026-10", party_id: "party-1", loan_id: "loan-1", opportunity_id: "opp-1", time_zones: [PHOENIX], state: "AZ",
    destinations: { email: { destination: "borrower@example.com", destination_id: "email-1" }, portal: { destination: "portal:party-1" }, ai_voice: { destination: CELL, destination_id: "phone-1", line_type: "mobile" }, human_voice: { destination: CELL, destination_id: "phone-1", line_type: "mobile" }, sms: { destination: CELL, destination_id: "phone-1", line_type: "mobile" } },
    facts: { partner_name: PARTNER, consents: [INFORMATIONAL], scrubs: [scrub], on_national_registry: false, ebr: { last_transaction_on: "2026-10-01" }, rate_sheet_current: true } });
  const entries = plan.entries as { channel: string; permitted: boolean; reason: string | null; local: { date: string; local_time: string; tz: string } | null; alternative_for: string | null; gates: { code: string; result: string }[] }[];
  const byChannel = (c: string) => entries.find((e) => e.channel === c)!;
  assert.equal(byChannel("email").permitted, true); assert.equal(byChannel("portal").permitted, true);
  assert.deepEqual([byChannel("ai_voice").permitted, byChannel("ai_voice").reason], [false, "no_pewc"]);
  assert.equal(byChannel("ai_voice").gates.find((g) => g.code === "TCPA_64_1200_A2_PEWC_GATE")!.result, "fail");
  assert.deepEqual([byChannel("sms").permitted, byChannel("sms").reason], [false, "no_pewc"]);
  const human = byChannel("human_voice");
  assert.deepEqual([human.permitted, human.alternative_for, human.local], [true, "ai_voice", { date: "2026-10-02", local_time: "10:30", tz: PHOENIX }]);
  assert.equal(human.gates.find((g) => g.code === "TCPA_64_1200_A2_PEWC_GATE")!.result, "not_applicable");      // no ATDS, no artificial voice: 227(b) does not apply
  assert.equal(human.gates.find((g) => g.code === "TCPA_64_1200_C2_NATIONAL_DNC_GATE")!.result, "pass");
  assert.equal((plan.ebr as { basis: string }).basis, "transaction_18m");
  // The AI-voice touch itself: queued → the gate arms on the loan (evaluator-backed) → suppressed{no_pewc}.
  const ai = await h.run("scheduleTouch", { facts: facts(h, creatives.find((c) => c.channel === "ai_voice")!, "ai_voice", MST("2026-10-02", "09:05"), { scrubs: [scrub] }) });
  assert.deepEqual([ai.outcome, ai.suppression_reason], ["suppressed", "no_pewc"]);
  const armed = h.timers.byCode("TCPA_64_1200_A2_PEWC_GATE"); assert.equal(armed.length, 1); assert.equal(armed[0]!.subject.id, "loan-1"); assert.equal(armed[0]!.note, "evaluator:20.2.pewcGate");
  assert.equal(ofType(h.events, "marketing.touch.suppressed")[0]!.payload.reason, "no_pewc");
  // The human click-to-dial alternative at 10:30 America/Phoenix: scheduled; its gates are satisfied by the scheduled touch.
  const slot = humanDialSlot(D("2026-10-02"), PHOENIX); assert.equal(slot.at, MST("2026-10-02", "10:30"));
  const hv = await h.run("scheduleTouch", { facts: facts(h, creatives.find((c) => c.channel === "human_voice")!, "human_voice", MST("2026-10-02", "09:05"), { scrubs: [scrub] }), scheduled_for: slot.at });
  assert.deepEqual([hv.outcome, hv.scheduled_local], ["scheduled", { date: "2026-10-02", local_time: "10:30", tz: PHOENIX }]);
  assert.ok(h.timers.byCode("TCPA_64_1200_C2_NATIONAL_DNC_GATE").every((t) => t.status === "satisfied"));
  assert.ok(h.timers.byCode("TCPA_64_1200_C1_QUIET_HOURS_GATE").every((t) => t.status === "satisfied"));
  assert.equal(h.decisions.length, 3);                                     // planChannels + 2 × scheduleTouch: every agent act leaves a decision row
});

test("20.2-T2: Given PEWC captured 2026-10-03 08:12 MST with disclosure v2.1 (both (f)(9) elements true, seller \"[Partner]\", number as entered), when an AI-voice touch is queued 2026-10-05 09:30 MST, then the gate passes, the (b) identification plays first, and the opt-out mechanism is offered within 2 s.", async () => {
  const h = harness(MST("2026-10-05", "09:30")); const { creatives } = seedCampaign(h);
  const cap = captureMarketingConsent(h.events, { consent_id: "c-pewc", party_id: "party-1", loan_id: "loan-1", kinds: ["tcpa_voice", "tcpa_sms"], phone_number: CELL, partner_name: PARTNER, signature_kind: "checkbox_with_text", captured_at: MST("2026-10-03", "08:12"), disclosure_version: "2.1", disclosure_text: PEWC_TEXT, elements: { authorizes_atds_or_artificial_voice: true, not_condition_of_purchase: true }, national_dnc_written_permission: true, evidence: { ip: "203.0.113.5", session_id: "s-1" } });
  assert.equal(cap.consents.length, 2);
  const voice = cap.consents.find((c) => c.kind === "tcpa_voice")!;
  assert.deepEqual([voice.purpose, voice.written_consent, voice.status, voice.signature_kind, voice.pewc_elements!.seller_named, voice.pewc_elements!.caller_on_behalf, voice.pewc_elements!.phone_number_as_entered, voice.national_dnc_written_permission], ["marketing", true, "active", "checkbox_with_text", PARTNER, "Supermortgage", CELL, true]);
  assert.equal(cap.events[0]!.payload.disclosure_version, "2.1"); assert.match(String(cap.events[0]!.payload.disclosure_text_hash), /^[0-9a-f]{64}$/);
  assert.deepEqual(pewcValid(voice, { partner_name: PARTNER, number: CELL, kind: "tcpa_voice" }), { valid: true, reasons: [], consent_id: "c-pewc:tcpa_voice" });
  assert.deepEqual(pewcValid(voice, { partner_name: "Prior Lender", number: CELL }).reasons, ["seller_named_mismatch"]);   // edge case: consent captured for a different seller
  const ai = await h.run("scheduleTouch", { facts: facts(h, creatives.find((c) => c.channel === "ai_voice")!, "ai_voice", MST("2026-10-05", "09:30"), { consents: [INFORMATIONAL, ...cap.consents] }) });
  assert.equal(ai.outcome, "scheduled");
  const gates = ai.gates as { code: string; result: string; basis: Record<string, unknown> }[];
  assert.deepEqual([gates.find((g) => g.code === "TCPA_64_1200_A2_PEWC_GATE")!.result, gates.find((g) => g.code === "TCPA_64_1200_A2_PEWC_GATE")!.basis.consent_id], ["pass", "c-pewc:tcpa_voice"]);
  assert.equal((ai.legal_basis as { tcpa: { required: string; consent_id: string } }).tcpa.required, "pewc");
  assert.ok(h.timers.byCode("TCPA_64_1200_A2_PEWC_GATE").every((t) => t.status === "satisfied"));
  // The (b) opening from the Notice Registry: identity first, the opt-out within 2 s (checklist rule optout-within-2s), then the call.
  const opening = render(AI_VOICE_IDENT_SOURCE, { ...AI_VOICE_IDENT_SAMPLE, partner_name: PARTNER });
  assert.match(opening.text, /^This is an automated call from Supermortgage on behalf of \[Partner\]/);
  const call = await h.run("placeCall", { touch_id: ai.touch_id, channel: "ai_voice", script: { opening_text: opening.text, ident_at_s: 0, optout_offer_at_s: 2, callback_number: "(800) 555-0100", prompt_version: "voice-prompt-v3", ai_disclosure_first: true }, placed_at: MST("2026-10-05", "09:31"), call_recording_id: "rec-1", transcript_id: "tr-1" });
  assert.deepEqual([call.mode, call.outcome, call.ident_played_first, call.optout_offered_within_s], ["ai_voice", "answered_ai", true, 2]);
  assert.ok((call.optout_offered_within_s as number) <= 2);
  const sent = ofType(h.events, "marketing.touch.sent")[0]!; assert.deepEqual([sent.payload.channel, sent.payload.ident_played_first, sent.payload.optout_offered_within_s, sent.payload.opportunity_id], ["ai_voice", true, 2, "opp-1"]);
  assert.deepEqual((call.contact as { mode: string; purpose: string; prompt_version: string }), { ...(call.contact as object), mode: "ai_voice", purpose: "marketing", prompt_version: "voice-prompt-v3" });
  // An opt-out offered at 3 s, or a script claiming to be a person, is refused before dialing.
  const t2 = await h.run("scheduleTouch", { facts: facts(h, creatives.find((c) => c.channel === "ai_voice")!, "ai_voice", MST("2026-10-05", "09:40"), { consents: [INFORMATIONAL, ...cap.consents] }) });
  await assert.rejects(h.run("placeCall", { touch_id: t2.touch_id, channel: "ai_voice", script: { opening_text: opening.text, ident_at_s: 0, optout_offer_at_s: 3, callback_number: "(800) 555-0100" } }), /within 2 s/);
  await assert.rejects(h.run("placeCall", { touch_id: t2.touch_id, channel: "ai_voice", script: { opening_text: "Hi, I am a person calling from Supermortgage.", ident_at_s: 0, optout_offer_at_s: 1, callback_number: "(800) 555-0100" } }), CommandRefused);
});

test("20.2-T3: Given a scrub obtained 2026-09-28, then `valid_until = 2026-10-29`; when no new scrub exists at 2026-10-30 00:00, then all `ai_voice`/`human_voice` solicitations are refused with `dnc_scrub_expired` until `dnc.scrub.completed`.", () => {
  const h = harness(ET("2026-09-28", "06:00")); const { creatives } = seedCampaign(h);
  const { scrub, event } = completeDncScrub(h.events, { scrub_id: "scrub-2026-09-28", obtained_at: ET("2026-09-28", "06:00"), numbers_checked: 12_000, hits: 340, file_hash: "sha256:0928" });
  assert.deepEqual([scrub.obtained_on, scrub.valid_until, DNC_SCRUB_VALIDITY_DAYS], ["2026-09-28", "2026-10-29", 31]);
  assert.equal(event.payload.valid_until, "2026-10-29");
  const t = h.timers.byCode("TCPA_64_1200_C2_DNC_SCRUB_31"); assert.equal(t.length, 1); assert.deepEqual([t[0]!.anchorDate, t[0]!.dueDate, t[0]!.status], ["2026-09-28", "2026-10-29", "armed"]);
  assert.equal(scrubInForce([scrub], D("2026-10-29"))?.scrub_id, "scrub-2026-09-28");
  assert.equal(scrubInForce([scrub], D("2026-10-30")), null);
  const pewc = captureMarketingConsent(h.events, { consent_id: "c-pewc", party_id: "party-1", loan_id: "loan-1", kinds: ["tcpa_voice"], phone_number: CELL, partner_name: PARTNER, signature_kind: "esign_click_typed_name", captured_at: MST("2026-10-03", "08:12"), disclosure_version: "2.1", disclosure_text: PEWC_TEXT, elements: { authorizes_atds_or_artificial_voice: true, not_condition_of_purchase: true } }).consents;
  for (const channel of ["ai_voice", "human_voice"] as const) {
    const c = checkGates(facts(h, creatives.find((x) => x.channel === channel)!, channel, MST("2026-10-30", "00:00"), { scrubs: [scrub], consents: [INFORMATIONAL, ...pewc] }));
    assert.deepEqual([c.pass, c.suppression_reason], [false, "dnc_scrub_expired"], channel);
    assert.equal(c.gates.find((g) => g.code === "TCPA_64_1200_C2_DNC_SCRUB_31")!.result, "fail");
  }
  const email = checkGates(facts(h, creatives.find((x) => x.channel === "email")!, "email", MST("2026-10-30", "00:00"), { scrubs: [scrub] }));
  assert.equal(email.suppression_reason, null);                            // e-mail / portal / mail continue (edge case: registry stale > 31 days)
  // A fresh version re-opens the gate and satisfies (and re-arms) the recurring row on the registry subject.
  const next = completeDncScrub(h.events, { scrub_id: "scrub-2026-10-30", obtained_at: ET("2026-10-30", "06:00"), numbers_checked: 12_050, hits: 351, file_hash: "sha256:1030" }).scrub;
  const again = checkGates(facts(h, creatives.find((x) => x.channel === "human_voice")!, "human_voice", MST("2026-10-30", "10:00"), { scrubs: [scrub, next] }));
  assert.deepEqual([again.pass, again.legal_basis.dnc.scrub_id], [true, "scrub-2026-10-30"]);
  assert.equal(h.timers.byCode("TCPA_64_1200_C2_DNC_SCRUB_31").find((x) => x.id === t[0]!.id)!.status, "satisfied");
  assert.ok(h.timers.byCode("TCPA_64_1200_C2_DNC_SCRUB_31").some((x) => x.status === "armed" && x.dueDate === "2026-11-30"));
});

test("20.2-T4: Given a number on the national registry and `ebr_basis=transaction_18m` (last payment 2026-10-01), then `TCPA_64_1200_C2_NATIONAL_DNC_GATE` passes; given the same number after a company DNC request on 2026-10-06, then the gate fails (EBR terminated) and `honor_until = 2031-10-06`.", () => {
  const h = harness(MST("2026-10-02", "09:05")); const { creatives } = seedCampaign(h);
  assert.deepEqual(ebrBasis({ as_of: D("2026-10-02"), last_transaction_on: D("2026-10-01") }), { basis: "transaction_18m", anchor_on: "2026-10-01", lapses_on: "2028-04-01", terminated_by_company_dnc: false });
  const before = checkGates(facts(h, creatives.find((x) => x.channel === "human_voice")!, "human_voice", MST("2026-10-02", "10:30"), { on_national_registry: true }));
  const g1 = before.gates.find((g) => g.code === "TCPA_64_1200_C2_NATIONAL_DNC_GATE")!;
  assert.deepEqual([g1.result, g1.basis.national_hit, g1.basis.ebr_basis, g1.basis.ebr_anchor_on], ["pass", true, "transaction_18m", "2026-10-01"]);
  assert.deepEqual([before.pass, before.legal_basis.dnc.ebr_basis], [true, "transaction_18m"]);
  // Worked example 2: "don't call me about refinancing" by e-mail Tue Oct 6 → company DNC, honored 5 years, processed at commit.
  const dnc = recordSuppression(h.events, { suppression_id: "sup-dnc-1", kind: "company_dnc", party_id: "party-1", loan_id: "loan-1", phone_number_id: "phone-1", requested_at: MST("2026-10-06", "13:02"), channel_received: "email", processed_at: MST("2026-10-06", "13:05"), time_zone: PHOENIX });
  assert.deepEqual([dnc.suppression.requested_on, dnc.suppression.honor_until], ["2026-10-06", "2031-10-06"]);
  assert.deepEqual(dnc.events.map((e) => [e.type, e.payload.kind]), [["marketing.suppression.requested", "company_dnc"], ["marketing.suppression.recorded", "company_dnc"]]);
  const five = h.timers.byCode("TCPA_64_1200_D_COMPANY_DNC_5Y"); assert.equal(five.length, 1); assert.deepEqual([five[0]!.anchorDate, five[0]!.dueDate, five[0]!.status], ["2026-10-06", "2031-10-06", "armed"]);
  const tenBd = h.timers.byCode("TCPA_64_1200_D3_DNC_REQUEST_10BD"); assert.equal(tenBd.length, 1);
  assert.deepEqual([tenBd[0]!.status, tenBd[0]!.dueDate], ["satisfied", "2026-10-21"]);   // +10 business_days_servicer from Oct 6 with Columbus Day closed = Wed Oct 21 (the verification report's recount); processed 13:05
  assert.equal(dnc.suppression.legal_due_on, "2026-10-21");
  const after = checkGates(facts(h, creatives.find((x) => x.channel === "human_voice")!, "human_voice", MST("2026-10-07", "10:30"), { on_national_registry: true, suppressions: [dnc.suppression] }));
  const g2 = after.gates.find((g) => g.code === "TCPA_64_1200_C2_NATIONAL_DNC_GATE")!;
  assert.deepEqual([g2.result, g2.basis.ebr_basis, g2.basis.ebr_terminated_by_company_dnc], ["fail", "none", true]);
  assert.deepEqual([after.pass, after.suppression_reason, after.gates.find((g) => g.code === "TCPA_64_1200_D_COMPANY_DNC_5Y")!.result], [false, "company_dnc", "fail"]);
  assert.deepEqual(ebrBasis({ as_of: D("2026-10-07"), last_transaction_on: D("2026-10-01"), company_dnc_requested_on: D("2026-10-06") }).basis, "none");
  // Servicing (informational) calls under 11.x are unaffected: the suppression is scoped to marketing channels; e-mail to the same party is not a company-DNC channel.
  const email = checkGates(facts(h, creatives.find((x) => x.channel === "email")!, "email", MST("2026-10-07", "10:30"), { suppressions: [dnc.suppression] }));
  assert.equal(email.gates.find((g) => g.code === "TCPA_64_1200_D_COMPANY_DNC_5Y")!.result, "not_applicable");
});

test("20.2-T5: Given an inbound \"STOP\" at 2026-10-06 13:02, then `consent.revoked{tcpa_sms}` is committed within 60 s, exactly one confirmation text is sent within 5 minutes with no marketing content, and no further SMS is sent to that number.", () => {
  const h = harness(MST("2026-10-06", "13:02")); const { creatives } = seedCampaign(h);
  const pewc = captureMarketingConsent(h.events, { consent_id: "c-pewc", party_id: "party-2", loan_id: "loan-1", kinds: ["tcpa_sms"], phone_number: "+16025550177", partner_name: PARTNER, signature_kind: "sms_keyword_double_optin", captured_at: MST("2026-10-03", "08:20"), disclosure_version: "2.1", disclosure_text: PEWC_TEXT, elements: { authorizes_atds_or_artificial_voice: true, not_condition_of_purchase: true } }).consents;
  const r = receiveSmsStop(h.events, { loan_id: "loan-1", phone_number_id: "phone-2", party_id: "party-2", text: "STOP", received_at: MST("2026-10-06", "13:02"), suppression_id: "sup-sms-1", source_touch_id: "t-sms-1" });
  assert.deepEqual([r.ingestion.revoked, r.ingestion.keyword], [true, "STOP"]);
  const revoked = ofType(h.events, "consent.revoked"); assert.equal(revoked.length, 1);
  assert.ok((revoked[0]!.payload.channels as string[]).includes("sms")); assert.equal(revoked[0]!.payload.method, "sms_keyword");
  assert.ok(Date.parse(String(revoked[0]!.payload.commit_by)) - Date.parse(MST("2026-10-06", "13:02")) <= 60_000);      // committed within 60 s (worked example 2: 13:02:20)
  assert.equal(ofType(h.events, "consent.revocation.honored").length, 1);                                              // 11.1's TCPA_64_1200_A10_REVOCATION_HONOR_10BD satisfied at commit
  const confirmations = ofType(h.events, "sms.confirmation.queued"); assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0]!.payload.count, 1);
  assert.ok(Date.parse(String(confirmations[0]!.payload.send_by)) - Date.parse(MST("2026-10-06", "13:02")) <= 5 * 60_000);   // within 5 minutes
  assert.deepEqual([r.confirmation_text, r.confirmation_marketing_free, marketingContentPresent(SMS_STOP_CONFIRMATION_TEXT)], [SMS_STOP_CONFIRMATION_TEXT, true, false]);
  assert.equal(marketingContentPresent("Reply YES to lock 6.125% today"), true);
  assert.deepEqual([r.suppression!.kind, r.suppression!.requested_on, r.suppression!.honor_until], ["sms_optout", "2026-10-06", null]);
  const withdrawn = withdrawConsent(pewc[0]!, new Date("2026-10-06T13:02:20-07:00").toISOString()); assert.equal(withdrawn.status, "withdrawn");
  // No further SMS to that number: the suppression and the withdrawn PEWC each refuse the touch.
  const later = scheduleTouch(h.events, facts(h, creatives.find((x) => x.channel === "sms")!, "sms", MST("2026-10-07", "10:00"), { consents: [withdrawn], suppressions: [r.suppression!] }, { party_id: "party-2", destination: "+16025550177", destination_id: "phone-2" }));
  assert.deepEqual([later.touch.outcome, later.touch.suppression_reason], ["suppressed", "no_pewc"]);
  assert.equal(later.check.gates.find((g) => g.code === "SUPPRESSION_SMS_OPTOUT")!.result, "fail");
  assert.deepEqual(findPewc([withdrawn], { partner_name: PARTNER, number: "+16025550177", kind: "tcpa_sms" }).reasons, ["status_withdrawn"]);
  assert.equal(ofType(h.events, "marketing.touch.sent").length, 0);
  // A non-keyword text revokes nothing and queues no confirmation.
  const q = receiveSmsStop(h.events, { loan_id: "loan-1", phone_number_id: "phone-2", party_id: "party-2", text: "What is the APR?", received_at: MST("2026-10-06", "13:10"), suppression_id: "sup-sms-2" });
  assert.deepEqual([q.ingestion.revoked, q.suppression, ofType(h.events, "sms.confirmation.queued").length], [false, null, 1]);
});

test("20.2-T6: Given an email opt-out received 2026-10-06, then `CANSPAM_7704_A4_OPTOUT_10BD.due_at = 2026-10-20` and `marketing_suppressions{email_optout}` is recorded the same day; an email queued 2026-10-07 is suppressed.", async () => {
  const h = harness(MST("2026-10-06", "10:00")); const { creatives } = seedCampaign(h);
  const out = await h.run("scheduleTouch", { op: "record_suppression", suppression_id: "sup-email-1", kind: "email_optout", party_id: "party-1", loan_id: "loan-1", email_id: "email-1", requested_at: MST("2026-10-06", "10:00"), channel_received: "email", source_touch_id: "t-email-1", time_zone: PHOENIX });
  assert.deepEqual([out.kind, out.requested_on, out.processed_at, out.honor_until], ["email_optout", "2026-10-06", MST("2026-10-06", "10:00"), null]);   // recorded the same day (policy: immediate at commit)
  const t = h.timers.byCode("CANSPAM_7704_A4_OPTOUT_10BD"); assert.equal(t.length, 1);
  assert.equal(t[0]!.anchorDate, "2026-10-06");
  assert.equal(t[0]!.dueDate, "2026-10-21");   // spec says 2026-10-20; +10 business_days_servicer from Tue Oct 6 skips Columbus Day (Mon Oct 12): Oct 7, 8, 9, 13, 14, 15, 16, 19, 20, 21 — the same off-by-one the verification report corrected for the TCPA ceiling
  assert.equal(t[0]!.status, "satisfied");
  assert.deepEqual(ofType(h.events, "marketing.suppression.requested").map((e) => e.payload.kind), ["email_optout"]);
  assert.equal((out as { legal_due_on: string }).legal_due_on, "2026-10-21");
  const sup = h.rt.store.get("marketing_suppressions", "sup-email-1")!.data as unknown as Suppression;
  const email = await h.run("scheduleTouch", { facts: facts(h, creatives.find((x) => x.channel === "email")!, "email", MST("2026-10-07", "09:05"), { suppressions: [sup] }) });
  assert.deepEqual([email.outcome, email.suppression_reason], ["suppressed", "email_optout"]);
  assert.equal((email.legal_basis as { canspam: { optout_state: string } }).canspam.optout_state, "opted_out");
  // Portal cards and mail are not covered by an e-mail opt-out; a human call is not either.
  const portal = checkGates(facts(h, creatives.find((x) => x.channel === "portal")!, "portal", MST("2026-10-07", "09:05"), { suppressions: [sup] }, { destination: "portal:party-1", destination_id: null, line_type: null }));
  assert.equal(portal.suppression_reason, null);
});

test("20.2-T7: Given a creative stating \"$3,402.62/month\" without an APR, when `runContentChecklist` executes, then `trigger_terms_present=true` and `d2_disclosures_present=false` → creative cannot be approved; adding \"6.155% APR, 360 monthly payments, fixed\" and the taxes-and-insurance statement makes it pass.", async () => {
  const h = harness(ET("2026-10-01", "12:00"));
  const base = `${PARTNER}, NMLSR ID 123456, is your current lender; Supermortgage services your loan for ${PARTNER}. Lower your payment to $3,402.62/month. This is not a commitment to lend.`;
  const a = await h.run("runContentChecklist", { text: base, channel: "mail", campaign_kind: "refi_trigger_outbound", ...SHEET });
  const ra = (a.checklists as { regz_1026_24: Record<string, boolean> }).regz_1026_24;
  assert.deepEqual([ra.trigger_terms_present, ra.d2_disclosures_present, ra.apr_stated, ra.f_payment_taxes_insurance_stmt], [true, false, false, false]);
  assert.deepEqual([a.pass, a.can_approve], [false, false]);
  assert.ok((a.failures as string[]).includes("regz_1026_24.d2_disclosures_present"));
  const creativeA: Creative = { creative_id: "cr-mail-a", campaign_id: "camp-x", channel: "mail", template_code: "NTC_REGZ_1026_24_REFI_OFFER", template_version: "1.0.0", content_hash: null, rate_sheet_id: null, variables_schema: [], checklists: null, status: "draft", approved_by: null, approved_at: null, superseded_by: null, prompt_version: null, disseminated_from: null, disseminated_to: null, rendered_text: base };
  const refusedA = approveCreative(h.events, creativeA, { approved_by: "human:u-officer", at: ET("2026-10-01", "12:00"), checklist_input: SHEET, campaign_kind: "refi_trigger_outbound" }, OFFICER);
  assert.ok(isRefusal(refusedA) && refusedA.reason === "checklist_failed" && refusedA.detail!.includes("regz_1026_24.d2_disclosures_present"));
  assert.equal(creativeA.status, "draft");
  const cured = `${base} 6.155% APR, 360 monthly payments, fixed. Payments do not include amounts for taxes and insurance premiums, and your actual payment obligation will be greater.`;
  const b = await h.run("runContentChecklist", { text: cured, channel: "mail", campaign_kind: "refi_trigger_outbound", ...SHEET });
  const rb = (b.checklists as { regz_1026_24: Record<string, boolean> }).regz_1026_24;
  assert.deepEqual([rb.trigger_terms_present, rb.d2_disclosures_present, rb.apr_stated, rb.apr_term_used, rb.f_payment_taxes_insurance_stmt], [true, true, true, true, true]);
  assert.deepEqual([b.pass, b.failures], [true, []]);
  const creativeB: Creative = { ...creativeA, creative_id: "cr-mail-b", rendered_text: cured };
  const ok = approveCreative(h.events, creativeB, { approved_by: "human:u-officer", at: ET("2026-10-01", "12:05"), checklist_input: SHEET, campaign_kind: "refi_trigger_outbound" }, OFFICER);
  assert.ok(!isRefusal(ok)); assert.deepEqual([creativeB.status, creativeB.approved_by], ["approved", "human:u-officer"]);
  // The pure checklist reproduces the same verdicts; "fixed" on an ARM, a rate off the sheet and "guaranteed" each fail.
  assert.equal(runContentChecklist({ text: cured, channel: "mail", campaign_kind: "refi_trigger_outbound", amortization: "arm" }).regz_1026_24.i1_fixed_ok, false);
  assert.ok(checklistFailures(runContentChecklist({ text: cured.replace("6.155% APR", "5.875% rate, 6.155% APR"), channel: "mail", campaign_kind: "refi_trigger_outbound", sheet_rates_pct: ["6.125"] })).includes("map_1014_3.a_rate_accurate"));
  assert.ok(checklistFailures(runContentChecklist({ text: `${cured} Guaranteed savings!`, channel: "mail", campaign_kind: "refi_trigger_outbound" })).includes("map_1014_3.r_no_guaranteed_claim"));
});

test("20.2-T8: Given a template variable `investor_name` (injected), then the schema check rejects the template; given rendered text containing \"Fannie Mae\", then `no_investor_reference=false` and the touch is suppressed.", async () => {
  const h = harness(MST("2026-10-02", "09:05")); const { creatives } = seedCampaign(h);
  assert.deepEqual(validateVariablesSchema(["borrower_name", "offered_rate_pct", "investor_name"]), { ok: false, rejected: ["investor_name"] });
  assert.throws(() => renderCreative("Hello {{borrower_name}}, your loan is owned by {{investor_name}}.", { borrower_name: "A. Borrower", investor_name: "Fannie Mae" }, ["borrower_name", "investor_name"]), (e: Error) => e instanceof RangeError && /investor_name/.test(e.message));
  await assert.rejects(h.run("renderCreative", { template: "Hello {{borrower_name}} {{investor_name}}", variables: { borrower_name: "A", investor_name: "B" }, variables_schema: ["borrower_name", "investor_name"] }), (e: unknown) => e instanceof CommandRefused && /NEVER_REFERENCE_INVESTORS/.test(String((e as Error).message)));
  // A clean schema renders and hashes the variant; an off-schema variable is refused at render.
  const rendered = await h.run("renderCreative", { creative_id: "cr-email", campaign_id: "camp-refi-2026-10", channel: "email", template: "Hello {{borrower_name}}, your offered rate is {{offered_rate_pct}}%.", variables: { borrower_name: "A. Borrower", offered_rate_pct: "6.125" }, variables_schema: ["borrower_name", "offered_rate_pct"] });
  assert.deepEqual([rendered.text, rendered.no_investor_reference], ["Hello A. Borrower, your offered rate is 6.125%.", true]);
  assert.throws(() => renderCreative("Hello {{borrower_name}} {{fnma_loan_number}}", { borrower_name: "A" }, ["borrower_name"]), RangeError);
  // Rendered text naming the investor: the regex check fails and the touch is suppressed (sev 2 edge case).
  const leaked = `${EMAIL_TEXT} Your loan is owned by Fannie Mae.`;
  assert.equal(noInvestorReference(leaked), false);
  assert.equal(runContentChecklist({ text: leaked, channel: "email", campaign_kind: "refi_trigger_outbound", ...SHEET }).fnma_b2_1_3_04.no_investor_reference, false);
  const email = creatives.find((x) => x.channel === "email")!;
  const touch = await h.run("scheduleTouch", { facts: facts(h, email, "email", MST("2026-10-02", "09:05"), { rendered_text: leaked }) });
  assert.deepEqual([touch.outcome, touch.suppression_reason], ["suppressed", "investor_reference"]);
  const gate = (touch.gates as { code: string; result: string; basis: { reason: string } }[]).find((g) => g.code === "SM_CAMPAIGN_CREATIVE_APPROVAL_GATE")!;
  assert.deepEqual([gate.result, gate.basis.reason], ["fail", "investor_reference"]);
  assert.equal(ofType(h.events, "marketing.touch.suppressed")[0]!.payload.reason, "investor_reference");
});

test("20.2-T9: Given called-party tz America/New_York and 20:30 local, then the AI-voice touch is refused (policy window ends 20:00) and rescheduled to 09:00 next permitted day; given 07:45 local, refused (rule floor 08:00).", async () => {
  const evening = quietHoursCheck({ at: ET("2026-10-05", "20:30"), time_zones: [NEW_YORK], channel: "ai_voice" });
  assert.deepEqual([evening.permitted, evening.reason, evening.window], [false, "after_policy_window_20:00", { open: "09:00", close: "20:00" }]);
  assert.deepEqual(evening.checks[0], { tz: NEW_YORK, local_date: "2026-10-05", local_time: "20:30", permitted: false, reason: "after_policy_window_20:00" });
  assert.deepEqual(evening.reschedule_to, { date: "2026-10-06", local_time: "09:00", tz: NEW_YORK, at: ET("2026-10-06", "09:00") });
  const morning = quietHoursCheck({ at: ET("2026-10-05", "07:45"), time_zones: [NEW_YORK], channel: "ai_voice" });
  assert.deepEqual([morning.permitted, morning.reason, morning.reschedule_to!.date, morning.reschedule_to!.local_time], [false, "before_rule_floor_08:00", "2026-10-05", "09:00"]);
  assert.equal(quietHoursCheck({ at: ET("2026-10-05", "08:30"), time_zones: [NEW_YORK], channel: "ai_voice" }).reason, "before_policy_window_09:00");
  assert.equal(quietHoursCheck({ at: ET("2026-10-05", "21:15"), time_zones: [NEW_YORK], channel: "human_voice" }).reason, "after_rule_ceiling_21:00");
  assert.equal(quietHoursCheck({ at: ET("2026-10-05", "12:00"), time_zones: [NEW_YORK], channel: "ai_voice" }).permitted, true);
  assert.equal(quietHoursCheck({ at: ET("2026-10-05", "12:00"), time_zones: [NEW_YORK], channel: "email" }).time_bound, false);
  // Stricter of the two time zones: 19:30 Phoenix is 22:30 New York → refused; Sunday Oct 4 and Columbus Day Oct 12 → next permitted day.
  const two = quietHoursCheck({ at: MST("2026-10-05", "19:30"), time_zones: [PHOENIX, NEW_YORK], channel: "ai_voice" });
  assert.deepEqual([two.permitted, two.checks.map((c) => c.permitted)], [false, [true, false]]);
  assert.deepEqual(quietHoursCheck({ at: ET("2026-10-04", "12:00"), time_zones: [NEW_YORK], channel: "sms" }).reschedule_to!.date, "2026-10-05");
  assert.deepEqual(quietHoursCheck({ at: ET("2026-10-12", "12:00"), time_zones: [NEW_YORK], channel: "ai_voice" }).reschedule_to!.date, "2026-10-13");
  // A state override narrows the window (e.g. 09:00–19:00): 19:30 is then after the window.
  assert.equal(quietHoursCheck({ at: ET("2026-10-05", "19:30"), time_zones: [NEW_YORK], channel: "ai_voice", state_window: { open: "09:00", close: "19:00" } }).reason, "after_policy_window_19:00");
  // Through the gate: the touch is not suppressed; it is rescheduled to 09:00 next permitted day.
  const h = harness(ET("2026-10-05", "20:30")); const { creatives } = seedCampaign(h);
  const pewc = captureMarketingConsent(h.events, { consent_id: "c-pewc", party_id: "party-1", loan_id: "loan-1", kinds: ["tcpa_voice"], phone_number: CELL, partner_name: PARTNER, signature_kind: "checkbox_with_text", captured_at: ET("2026-10-03", "11:12"), disclosure_version: "2.1", disclosure_text: PEWC_TEXT, elements: { authorizes_atds_or_artificial_voice: true, not_condition_of_purchase: true } }).consents;
  const t = await h.run("scheduleTouch", { facts: facts(h, creatives.find((x) => x.channel === "ai_voice")!, "ai_voice", ET("2026-10-05", "20:30"), { consents: pewc }, { time_zones: [NEW_YORK], state: "OH" }) });
  assert.deepEqual([t.outcome, t.scheduled_local, t.scheduled_for], ["scheduled", { date: "2026-10-06", local_time: "09:00", tz: NEW_YORK }, ET("2026-10-06", "09:00")]);
  assert.equal(ofType(h.events, "marketing.touch.scheduled")[0]!.payload.rescheduled, true);
  await assert.rejects(h.run("assertGateOpen", { code: "TCPA_64_1200_C1_QUIET_HOURS_GATE", at: ET("2026-10-05", "07:45"), time_zones: [NEW_YORK], channel: "ai_voice" }), /before_rule_floor_08:00/);
});

test("20.2-T10: Given a creative last disseminated 2026-10-02 and superseded 2026-10-15, then `REGN_1014_5_RECORDS_24M.due_at = 2028-10-02` and the archive contains the rendered variants, the voice prompt version and the product list in force.", () => {
  const h = harness(ET("2026-10-15", "09:00")); const { creatives } = seedCampaign(h);
  const voice = creatives.find((x) => x.channel === "ai_voice")!;
  const r = supersedeCreative(h.events, voice, { superseded_by: "cr-ai_voice-v2", at: ET("2026-10-15", "09:00"), last_disseminated_on: D("2026-10-02") });
  assert.deepEqual([r.archive_until, voice.status, voice.superseded_by, voice.disseminated_to], ["2028-10-02", "superseded", "cr-ai_voice-v2", "2026-10-02"]);
  const t = h.timers.byCode("REGN_1014_5_RECORDS_24M"); assert.equal(t.length, 1);
  assert.deepEqual([t[0]!.anchorDate, t[0]!.dueDate, t[0]!.status, t[0]!.subject], ["2026-10-02", "2028-10-02", "armed", { kind: "marketing_creative", id: "cr-ai_voice" }]);
  // The MAP archive must hold the rendered variants (by content hash), the voice prompt version and the product list in force.
  const incomplete = verifyMapArchive(h.events, voice, { rendered_variants: [{ content_hash: voice.content_hash!, channel: "ai_voice" }], prompt_version: null, product_list: ["FRM30 LCOR 6.125%"], retained_through: D("2028-10-02") }, { archive_until: r.archive_until, at: ET("2026-10-15", "09:05") });
  assert.deepEqual([incomplete.complete, incomplete.missing], [false, ["prompt_version"]]);
  assert.equal(t[0]!.status, "armed");
  const complete = verifyMapArchive(h.events, voice, { rendered_variants: [{ content_hash: voice.content_hash!, channel: "ai_voice" }, { content_hash: "sha256:variant-b", channel: "ai_voice" }], prompt_version: "voice-prompt-v3", product_list: ["FRM30 LCOR 6.125%", "FRM30 same-term 6.000%"], retained_through: D("2028-10-02") }, { archive_until: r.archive_until, at: ET("2026-10-15", "09:06") });
  assert.deepEqual([complete.complete, complete.missing, complete.event.payload.variants, complete.event.payload.prompt_version], [true, [], 2, "voice-prompt-v3"]);
  assert.equal(t[0]!.status, "satisfied");
  // A superseded creative can no longer be sent (SM_CAMPAIGN_CREATIVE_APPROVAL_GATE).
  const c = checkGates(facts(h, voice, "ai_voice", ET("2026-10-15", "10:00")));
  assert.equal(c.gates.find((g) => g.code === "SM_CAMPAIGN_CREATIVE_APPROVAL_GATE")!.basis.reason, "creative_superseded");
  // campaign.ended anchors the same clock at the last dissemination + 24 months.
  const camp = h.rt.store.get("marketing_campaigns", "camp-refi-2026-10")!.data as unknown as Campaign;
  assert.equal(ofType(h.events, "creative.superseded")[0]!.payload.archive_until, "2028-10-02");
  assert.equal(camp.status, "live");
});

test("20.2-T11: Given `marketing.prescreen_enabled=false`, when a campaign of kind `prescreen` is created, then approval is refused with `feature_disabled`; given the flag on, a written solicitation without the 12 CFR 1022.54(c) short notice fails `FCRA_615D_PRESCREEN_NOTICE_GATE`.", async () => {
  const h = harness(ET("2026-10-01", "12:00"));
  const created = await h.run("planChannels", { op: "create_campaign", campaign_id: "camp-prescreen-1", partner_id: "partner-1", kind: "prescreen", channels: ["mail"], selection_rule_set: "sm.prescreen.2026.v1" });
  assert.deepEqual([created.kind, created.status], ["prescreen", "draft"]);
  const refused = await h.run("planChannels", { op: "approve_campaign", campaign_id: "camp-prescreen-1" }, OFFICER);
  assert.deepEqual([refused.refused, refused.reason, refused.status], [true, "feature_disabled", "draft"]);
  assert.equal(ofType(h.events, "campaign.approved").length, 0);
  await assert.rejects(h.run("planChannels", { op: "approve_campaign", campaign_id: "camp-prescreen-1" }), CommandRefused);   // the agent cannot approve at all
  const camp = h.rt.store.get("marketing_campaigns", "camp-prescreen-1")!.data as unknown as Campaign;
  const r = approveCampaign(h.events, camp, { approved_by: "human:u-officer", at: ET("2026-10-01", "12:00"), creatives: [], flags: { prescreen_enabled: false } }, OFFICER);
  assert.ok(isRefusal(r) && r.reason === "feature_disabled");
  // Flag on: the written solicitation needs the short and long notices, frozen criteria and the 25-month retention.
  assert.deepEqual(prescreenNoticeGate({ campaign_kind: "prescreen", channel: "mail", flags: { prescreen_enabled: true }, prescreen: { short_notice_present: false, long_notice_present: true, criteria_frozen: true, retention_25m_set: true } }), { open: false, reason: "short_notice_1022_54c" });
  assert.deepEqual(prescreenNoticeGate({ campaign_kind: "prescreen", channel: "mail", flags: { prescreen_enabled: true }, prescreen: { short_notice_present: true, long_notice_present: true, criteria_frozen: true, retention_25m_set: true } }), { open: true });
  assert.deepEqual(prescreenNoticeGate({ campaign_kind: "prescreen", channel: "mail", flags: { prescreen_enabled: false }, prescreen: { short_notice_present: true, long_notice_present: true, criteria_frozen: true, retention_25m_set: true } }), { open: false, reason: "feature_disabled" });
  assert.deepEqual(prescreenNoticeGate({ campaign_kind: "refi_trigger_outbound", channel: "mail" }), { open: true });
  const { creatives } = seedCampaign(h, ["mail"], "prescreen");
  const gate = checkGates(facts(h, creatives[0]!, "mail", ET("2026-10-02", "10:00"), { flags: { prescreen_enabled: true }, prescreen: { short_notice_present: false, long_notice_present: true, criteria_frozen: true, retention_25m_set: true } }, { campaign_kind: "prescreen", destination: "100 Example Way, Anytown, AZ 85000", destination_id: "addr-1", line_type: null }));
  assert.deepEqual([gate.gates.find((g) => g.code === "FCRA_615D_PRESCREEN_NOTICE_GATE")!.result, gate.suppression_reason], ["fail", "prescreen_notice_missing"]);
  const t = h.timers.byCode("FCRA_615D_PRESCREEN_NOTICE_GATE"); assert.equal(t.length, 0);
  const queued = scheduleTouch(h.events, facts(h, creatives[0]!, "mail", ET("2026-10-02", "10:00"), { flags: { prescreen_enabled: true }, prescreen: { short_notice_present: false, long_notice_present: true, criteria_frozen: true, retention_25m_set: true } }, { campaign_kind: "prescreen", destination: "100 Example Way, Anytown, AZ 85000", destination_id: "addr-1", line_type: null }));
  assert.equal(queued.touch.outcome, "suppressed");
  assert.equal(h.timers.byCode("FCRA_615D_PRESCREEN_NOTICE_GATE").length, 1);   // arms on marketing.touch.queued{campaign_kind=prescreen}
  assert.equal(h.timers.byCode("FCRA_615D_PRESCREEN_NOTICE_GATE")[0]!.note, "evaluator:20.2.prescreenNoticeGate");
});

test("20.2-T12: Given a `voice_recording_interim` consent captured 2026-10-05 14:00 without written confirmation by 2026-10-06 14:00, then status `expired` and no AI-voice marketing call is placed under it.", () => {
  const h = harness(MST("2026-10-05", "14:00")); const { creatives } = seedCampaign(h);
  const cap = captureMarketingConsent(h.events, { consent_id: "c-interim", party_id: "party-1", loan_id: "loan-1", kinds: ["tcpa_voice"], phone_number: CELL, partner_name: PARTNER, signature_kind: "voice_recording_interim", captured_at: MST("2026-10-05", "14:00"), disclosure_version: "2.1", disclosure_text: PEWC_TEXT, elements: { authorizes_atds_or_artificial_voice: true, not_condition_of_purchase: true }, national_dnc_written_permission: true, evidence: { call_id: "call-77" } });
  const c = cap.consents[0]!;
  assert.deepEqual([c.status, c.written_consent, c.written_confirmation_due_at, c.national_dnc_written_permission], ["pending_written_confirmation", false, MST("2026-10-06", "14:00"), false]);
  assert.deepEqual(pewcValid(c, { partner_name: PARTNER, number: CELL }).reasons, ["not_written", "status_pending_written_confirmation", "no_written_signature"]);
  // Before the due time nothing expires; at 14:00 the next day the consent is `expired`.
  assert.equal(expireInterimConsent(h.events, c, MST("2026-10-06", "13:59")).expired, false);
  const ex = expireInterimConsent(h.events, c, MST("2026-10-06", "14:00"));
  assert.deepEqual([ex.expired, ex.consent.status, ex.event!.type, ex.event!.payload.reason], [true, "expired", "consent.expired", "written_confirmation_missing"]);
  assert.deepEqual(pewcValid(ex.consent, { partner_name: PARTNER, number: CELL }).reasons, ["not_written", "status_expired", "no_written_signature"]);
  const gate = scheduleTouch(h.events, facts(h, creatives.find((x) => x.channel === "ai_voice")!, "ai_voice", MST("2026-10-06", "14:05"), { consents: [INFORMATIONAL, ex.consent] }));
  assert.deepEqual([gate.touch.outcome, gate.touch.suppression_reason], ["suppressed", "no_pewc"]);
  assert.throws(() => placeCall(h.events, gate.touch, { opening_text: VOICE_TEXT, ident_at_s: 0, optout_offer_at_s: 2, callback_number: "(800) 555-0100", prompt_version: null }, { placed_at: MST("2026-10-06", "14:06") }), /never dial/);
  assert.equal(ofType(h.events, "marketing.touch.sent").length, 0);
  // A written confirmation inside 24 h would have made it active PEWC (the conservative default of open question 1).
  const cap2 = captureMarketingConsent(h.events, { consent_id: "c-interim-2", party_id: "party-1", loan_id: "loan-1", kinds: ["tcpa_voice"], phone_number: CELL, partner_name: PARTNER, signature_kind: "voice_recording_interim", captured_at: MST("2026-10-05", "14:00"), disclosure_version: "2.1", disclosure_text: PEWC_TEXT, elements: { authorizes_atds_or_artificial_voice: true, not_condition_of_purchase: true } }).consents[0]!;
  assert.equal(expireInterimConsent(h.events, cap2, MST("2026-10-05", "20:00")).consent.status, "pending_written_confirmation");
});

test("20.2 worked figures: the fixture offer renders 7.000% → 6.125% (6.155% APR) and 360 payments of $3,402.62 from the 20.1 candidate ($560,000 at 6.125%) and passes the §1026.24 checklist", () => {
  assert.equal(levelPayment(56_000_000n, ratePercent("6.125"), 360), 340_262n);        // $3,402.62 — the payment the creative states
  const reg = buildRegistry(); for (const v of VERSIONS_20_2) reg.publish(v.templateCode, v.version, "counsel", "2026-09-01T00:00:00.000Z", publishCheck);
  const version = reg.activeVersion("NTC_REGZ_1026_24_REFI_OFFER", D("2026-10-02"))!;
  const payload = { ...REFI_OFFER_SAMPLE, partner_name: PARTNER, pi_cents: levelPayment(56_000_000n, ratePercent("6.125"), 360) };
  const rendered = render(REFI_OFFER_SOURCE, payload);
  assert.match(rendered.text, /Your current rate 7\.000% → offered rate 6\.125% \(6\.155% annual percentage rate \(APR\)\); 360 monthly principal-and-interest payments of \$3,402\.62/);
  assert.match(rendered.text, /do not include amounts for taxes and insurance premiums, and your actual payment obligation will be greater/);
  assert.match(rendered.text, /\[Partner\], NMLSR ID 123456, is your current lender; Supermortgage services your loan for \[Partner\]/);
  const checklist = evaluateChecklist(version, payload, rendered);
  assert.deepEqual([checklist.passed, checklist.blocking], [true, []]);
  const c = runContentChecklist({ text: rendered.text, channel: "email", campaign_kind: "refi_trigger_outbound", sheet_rates_pct: ["6.125"] });
  assert.deepEqual(checklistFailures(c), []);
  // An ARM rendered with "fixed", or an offer above the current rate, is held by the checklist.
  assert.equal(evaluateChecklist(version, { ...payload, amortization: "arm" }, render(REFI_OFFER_SOURCE, { ...payload, amortization: "arm" })).passed, false);
  assert.equal(evaluateChecklist(version, { ...payload, offered_rate_pct: "7.125" }, render(REFI_OFFER_SOURCE, { ...payload, offered_rate_pct: "7.125" })).passed, false);
});
