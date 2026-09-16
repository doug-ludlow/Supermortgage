/**
 * 33.3 — Refinance readiness on the borrower surface (spec/sections/33-partner-book/33-3-*.md, rules 3, 4 and 5): the homeowner's
 * Yes on a monitored loan opens the refinance application; every verification event afterwards recomputes the readiness row;
 * the refinance that funds pays the monitored loan off. The daily pass (rule 1 / readiness.run) is the runtime sweep's
 * (src/runtime/partner-book-readiness.ts readinessRun); this flow is the event side.
 *
 *   refi.opportunity.engaged (loan-scoped, a monitored loan)   → `refiOpen` (rule 3: the borrower's own Yes — 32.2 offer.respond's actor, the lead
 *                                                               the party owns or a resolved OfferCard with yes — opens the application; two Yes
 *                                                               taps → one application), then the first readiness row with the application
 *   application.received (a refinance application whose        → 32.3 E4 first: `lead.authenticated{L1}` on the borrower's own session (20.3's lead was created at L0
 *     prior_loan_id is a monitored loan)                         by the Yes; the hard-pull authorization needs ≥ L1) — then
 *                                                               the connector cards 32.3 E5 / R3 and 32.18 rule 1 open for every applicant — the
 *     prior_loan_id is a monitored loan)                         identity scan, the payroll connection (unless a standing authorization refreshes
 *                                                               it — 32.11 §5 / DELTA-05) and the assets connection — with 3-entry's own flow keys
 *                                                               (`connect.identity:<party>`, …) so routes identitySession / connectSession run on
 *                                                               them. Rule 4: an identity verified on an earlier application of the party within
 *                                                               its validity (partner-book-readiness identityOnFile `present`) is NOT asked again —
 *                                                               no scan card; the SSN card (the one typed field) opens at once instead.
 *                                                               3-entry stands down for a refi_trigger application (`asksHere`); 32.11's
 *                                                               compressedCards send the six-item, profile, declarations, demographics, credit
 *                                                               authorization and E-SIGN cards. A masked "SSN on file" card for a party with no
 *                                                               SSN on file is withdrawn: the SSN is typed (rule 4: identity → SSN → …).
 *   identity.verified                                          → the identity ConfirmCard (32.3 R1, from the vendor's prefill) and the one typed
 *                                                               field, the SSN card (32.18 rule 1) — when no tin_last4 is on file
 *   identity.verified, credit.report.received,                 → `readinessCheck` for the loan in the same settlement (rule 4: the row is
 *     verification.received{income|assets}, consent.captured /   recomputed on every triggering event; one row per application per commit)
 *     consent.granted / consent.esign.active,
 *     credit.authorization.captured,
 *     application.six_item.captured{ssn}, income.validated
 *   credit.authorization.captured, six_item.captured{ssn}     → the credit pull (32.18 rule 2) once the six items, the SSN and the hard-pull
 *                                                               authorization are in — 3-entry's own pull runs only on `application.trid_received`
 *                                                               for a refi_trigger application, so an authorization that lands later pulls here
 *   verification.received{income}                              → the income ConfirmCard from the FAKE Truv report (32.3 R3 — 3-entry's incomeCard, gated out here by asksHere)
 *   verification.received, six_item.captured{income}          → the DU moment (32.18 rule 3) when the last prerequisite is the income or the assets
 *                                                               report — 3-entry's own runs only on trid_received / credit.report.received here
 *   partner_book.readiness.checked{application_id}            → the scan card asked once more when the row reads identity stale or missing on an
 *                                                               open refinance application with no pending scan card (the edge case "an identity
 *                                                               verified on an earlier application has expired → stale; the scan card is asked once
 *                                                               more"; the state machine's present → stale): the daily pass itself orders nothing
 *   loan.boarded / loan.funded (the refinance application)    → rule 5 as 35.10 builds it: the monitored prior loan is retired by the refinance
 *                                                               closeout (src/domain/operations-runtime/closeout-35-10: closeout.retire emits
 *                                                               `partner_book.loan.paid_off` with this flow's payload once the partner's demand is paid
 *                                                               from the settlement statement, and the 35.1 projector flips loans.status — nothing here
 *                                                               writes it); readiness rows stop for that loan (the sweep and this
 *                                                               flow only check a loan that is still `monitored`); a withdrawn / denied / cancelled
 *                                                               application (the event — nothing writes applications.status) is no longer this flow's
 *                                                               (`appContext` null): a late event on it writes no row
 *
 * Readiness never opens a card itself (rule 2): the cards here are the owning processes' asks, sent through 32.1's `send_card`
 * as the intake agent exactly as flows/3-entry.ts sends them for an organic applicant; no vendor is called from here, no figure
 * is computed. Every reaction is idempotent (cards by party × flow key × application; the pull and the DU run by the log).
 */
import type { Actor, DomainEvent } from "../../../kernel/events/index.ts";
import { addDays } from "../../../kernel/calendar/date.ts";
import { wallClock } from "../../../kernel/calendar/zoned.ts";
import { EntityStore } from "../../../app/tools.ts";
import { ET } from "../../partner-book-review.ts";
import { PROJECTED_NOTE_DAYS, RefiOpenRefused, applicationClosedByEvent, identityOnFile, readinessCheck, refiOpen } from "../../partner-book-readiness.ts";
import { RESIDENCE_FIELDS } from "./3-entry.ts";
import type { BorrowerFlow, FlowDeps } from "./index.ts";

export const FLOW_ID = "33.3";
const INTAKE: Actor = { kind: "agent", id: "intake" };
const VERIFICATION: Actor = { kind: "agent", id: "verification" };
const BORROWER_APP: Actor = { kind: "agent", id: "borrower-app" };
const READINESS: Actor = { kind: "agent", id: "refi-readiness" };
const RUN = { runId: "flow:33.3", modelVersion: "borrower flows (deterministic)", promptVersion: "33.3" } as const;
export const CREATED_BY_INTAKE = "agent:intake";
/** Rule 5: the monitored loan a funded refinance pays off (loan-scoped on the prior loan, `origination: true`). */
export const LOAN_PAID_OFF_EVENT = "partner_book.loan.paid_off";
/** 32.18 rule 2's order (the same env-configured reseller identifiers flows/3-entry.ts uses). */
const CREDIT_ORDER = { permissible_purpose: "credit_transaction_604a3A", certification_ref: process.env["CREDIT_CERTIFICATION_REF"] ?? "CERT-PARTNER-FAKE-2026", subscriber_code: process.env["CREDIT_SUBSCRIBER_CODE"] ?? "SUB-PARTNER-FAKE" } as const;

type P = Record<string, unknown>;
const pl = (e: DomainEvent): P => e.payload as P;
const s = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));

// ---------------------------------------------------------------- the application context (a refinance application from a monitored loan)
interface Party { readonly party_id: string; readonly application_borrower_id: string; readonly legal_name: string; readonly tin_last4: string | null; readonly prefill: P }
interface AppCtx { readonly appId: string; readonly loanId: string; readonly loanStatus: string; readonly events: readonly DomainEvent[]; readonly store: EntityStore; readonly parties: readonly Party[]; readonly now: string; readonly lead: P | null }
const has = (ctx: AppCtx, type: string, where: (p: P) => boolean = () => true): boolean => ctx.events.some((e) => e.type === type && where(pl(e)));

/** The application with its prior loan when that loan is on the partner book (monitored, or paid off by this very refinance); null for any other application, and null once the application was withdrawn / denied / cancelled (rule 5: readiness rows stop — the closing event, since nothing on the platform writes applications.status for it). */
async function appContext(deps: FlowDeps, appId: string): Promise<AppCtx | null> {
  const db = deps.runtime.db;
  const app = (await db.query<{ prior_loan_id: string | null; status: string | null }>(`SELECT a.prior_loan_id::text AS prior_loan_id, l.status::text AS status FROM applications a LEFT JOIN loans l ON l.id = a.prior_loan_id WHERE a.id = $1`, [appId]))[0];
  if (!app?.prior_loan_id || !app.status || (app.status !== "monitored" && app.status !== "paid_off")) return null;
  if (await applicationClosedByEvent(db, appId)) return null;
  const [events, records, parties] = await Promise.all([deps.runtime.uow.events.byApplication(appId), deps.runtime.entities.load({ applicationId: appId }),
    db.query<Party & P>(`SELECT party_id::text AS party_id, id::text AS application_borrower_id, legal_name, tin_last4, prefill FROM application_borrowers WHERE application_id = $1 AND party_id IS NOT NULL ORDER BY (borrower_role::text = 'borrower') DESC, created_at, id`, [appId])]);
  const store = new EntityStore(); store.seed(records);
  const lead = (store.get("leads", appId)?.data as P | undefined) ?? (store.list("leads", (d) => d["application_id"] === appId).map((r) => r.data as P)[0] ?? null);
  return { appId, loanId: app.prior_loan_id, loanStatus: app.status, events, store, parties: parties.map((p) => ({ ...p, prefill: (p.prefill ?? {}) as P })), now: deps.runtime.clock.now(), lead };
}
/** 21.1's own borrower ids ("B1") by legal name on the intake record (the credit order names them). */
const intakeBorrowerIds = (ctx: AppCtx): string[] => (((ctx.store.get("applications", ctx.appId)?.data as { borrowers?: { id: string }[] } | undefined)?.borrowers ?? []).map((b) => String(b.id)).filter(Boolean));
const asOfOf = (now: string) => { const d = wallClock(Date.parse(now), ET).date; return { as_of_date: d, projected_note_date: addDays(d, PROJECTED_NOTE_DAYS) }; };

// ---------------------------------------------------------------- 32.1's send_card as the intake agent; idempotent on party × flow key × application
interface CardSpec { readonly kind: string; readonly copy_key: string; readonly props: P; readonly command_ref?: string; readonly flow_key: string }
async function existingCard(deps: FlowDeps, partyId: string, flowKey: string, appId: string): Promise<{ card_instance_id: string; status: string } | undefined> {
  return (await deps.runtime.db.query<{ card_instance_id: string; status: string }>(`SELECT card_instance_id, status FROM card_instances WHERE party_id = $1 AND props->>'flow_key' = $2 AND subject_application_id = $3 ORDER BY created_at DESC LIMIT 1`, [partyId, flowKey, appId]))[0];
}
async function sendCard(deps: FlowDeps, ctx: AppCtx, party: Pick<Party, "party_id">, c: CardSpec): Promise<string> {
  const prior = await existingCard(deps, party.party_id, c.flow_key, ctx.appId);
  if (prior) return prior.card_instance_id;
  const r = await deps.runtime.execute({ process: "32.1", name: "send_card", loanId: "", applicationId: ctx.appId, actor: INTAKE, run: { ...RUN },
    input: { party_id: party.party_id, kind: c.kind, copy_key: c.copy_key, props: { ...c.props, flow_key: c.flow_key, flow: FLOW_ID }, command_ref: c.command_ref ?? null, body_text: null, expires_at: null, subject: { application_id: ctx.appId, loan_id: null }, created_by: CREATED_BY_INTAKE, rationale: `33.3 ${c.kind} ${c.copy_key} on ${c.flow_key} (the owning process's ask on the refinance application from a monitored loan)` } });
  return (r.output as { card_instance_id: string }).card_instance_id;
}
async function standingConsent(deps: FlowDeps, partyId: string): Promise<{ id: string } | undefined> {
  return (await deps.runtime.db.query<{ id: string }>(`SELECT id::text AS id FROM consents WHERE party_id = $1 AND kind = 'blanket_verification_authorization' AND standing AND (status IS NULL OR status = 'active') ORDER BY captured_at DESC LIMIT 1`, [partyId]))[0];
}
const leadIdOf = (ctx: AppCtx): string | null => (ctx.lead ? s(ctx.lead["lead_id"]) : null);

/** The session's auth method as 20.3's `authenticate{method}` (flows/3-entry.ts AUTH_20_3: 32.2 `party.authenticate` maps the platform's names). */
const AUTH_20_3: Record<string, string> = { otp_phone: "otp_phone", otp_email: "otp_email", passkey: "passkey", oidc_google: "oidc_google", password: "otp_email", video: "otp_email" };
/**
 * 32.3 E4 for the refinance application: `lead.authenticated{level=L1}` on the borrower's own session — the session itself is the API's (01 §5).
 * 32.2 offer.respond creates 20.3's lead at L0 (the homeowner's Yes on the OfferCard), and 3-entry's session hook stands down for a refi_trigger
 * application; without it 20.3 rule 2 refuses the hard-pull authorization (FCRA_1681B_A3_SOFT_PULL_PURPOSE_GATE: assurance_level ≥ L1). Once.
 */
async function authenticateLead(deps: FlowDeps, ctx: AppCtx): Promise<void> {
  const lead_id = leadIdOf(ctx); if (!lead_id) return;
  const level = String(ctx.lead?.["assurance_level"] ?? "L0_contact_unverified"); const rank = Number(/^L(\d)/.exec(level)?.[1] ?? 0);   // 20.3's ASSURANCE_LEVELS: L0_contact_unverified … L4_ssa_cbsv
  if (rank >= 1 || has(ctx, "lead.authenticated")) return;
  for (const party of ctx.parties) {
    const session = (await deps.runtime.db.query<{ session_id: string; auth_method: string }>(`SELECT session_id, auth_method::text AS auth_method FROM sessions WHERE party_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [party.party_id]))[0];
    if (!session) continue;
    try { await exec(deps, ctx.appId, "32.2", "party.authenticate", BORROWER_APP, { lead_id, method: AUTH_20_3[session.auth_method] ?? "otp_email", session_id: session.session_id, party_id: party.party_id }); return; }
    catch (err) { deps.logger?.warn("borrower.flow.33-3.lead.authenticate.failed", { application_id: ctx.appId, lead_id, party_id: party.party_id, error: err instanceof Error ? err.message : String(err) }); }
  }
}

/** A pending identity scan card of the party on the application (any flow's — 3-entry's key or this flow's). */
async function pendingScanCard(deps: FlowDeps, ctx: AppCtx, partyId: string): Promise<boolean> {
  return (await deps.runtime.db.query(`SELECT 1 FROM card_instances WHERE subject_application_id = $1 AND party_id = $2 AND kind = 'ConnectCard' AND props->>'vendor' = 'stripe_identity' AND status = 'pending'`, [ctx.appId, partyId])).length > 0;
}
/** 32.3 E5's ask: the identity scan card (3-entry's props and flow key so routes identitySession runs on it); once a card with that key was already answered or withdrawn, a re-ask (the identity went stale) carries the as-of date in its key. */
async function scanCard(deps: FlowDeps, ctx: AppCtx, party: Party, asOf: string): Promise<void> {
  if (await pendingScanCard(deps, ctx, party.party_id)) return;
  const key = `connect.identity:${party.party_id}`;
  const prior = await existingCard(deps, party.party_id, key, ctx.appId);
  await sendCard(deps, ctx, party, { kind: "ConnectCard", copy_key: "identity.stripe.purpose", flow_key: prior && prior.status !== "pending" ? `${key}:${asOf}` : key,
    props: { vendor: "stripe_identity", purpose_text: "", what_we_get: ["your name", "date of birth", "the address on your ID"], fallback: { label: "Upload a photo of your ID instead", document_class: "drivers_license" }, state: "not_started", vendor_fake: "FAKE" } });
}
/** 32.18 rule 1's one typed field — the SSN card — when nothing is on file for the applicant (read now, not from the batch's context); idempotent on `identity.ssn:<application_borrower_id>`. */
async function ssnCard(deps: FlowDeps, ctx: AppCtx, party: Party): Promise<void> {
  const lead_id = leadIdOf(ctx);
  const onFile = (await deps.runtime.db.query<{ tin_last4: string | null }>(`SELECT tin_last4 FROM application_borrowers WHERE id = $1`, [party.application_borrower_id]))[0]?.tin_last4 ?? null;
  if (onFile) return;
  await sendCard(deps, ctx, party, { kind: "ConfirmCard", copy_key: "identity.ssn.title", flow_key: `identity.ssn:${party.application_borrower_id}`, command_ref: "application.confirmField",
    props: { title: "", fields: [{ path: "ssn", label: "Social Security number", value: "", source: "borrower" }], commits_to: "application_borrowers", masked_paths: ["ssn"], required_paths: ["ssn"], helper_copy_key: "identity.ssn.why", gate: "FNMA_B2_2_01_SSN_VALIDATION_GATE", command_args: { path: "ssn", source: "borrower", ...(lead_id ? { lead_id } : {}) } } });
}
/** 32.3 E5 / R3 and 32.18 rule 1 for the refinance application: the ID scan — unless an identity verified on an earlier application of the party is still within its validity (rule 4: not asked again; the SSN card opens at once) — the payroll connection (unless standing), the assets connection — 3-entry's own props and flow keys. */
async function connectorCards(deps: FlowDeps, ctx: AppCtx): Promise<void> {
  const { as_of_date, projected_note_date } = asOfOf(ctx.now);
  for (const party of ctx.parties) {
    const lead_id = leadIdOf(ctx);
    const identity = await identityOnFile(deps.runtime.db, party.party_id, ctx.appId, projected_note_date);
    if (identity?.status === "present") { deps.logger?.info("borrower.flow.33-3.identity.on_file", { application_id: ctx.appId, party_id: party.party_id, verification_id: identity.id, valid_until: identity.valid_until, projected_note_date: String(projected_note_date) }); await ssnCard(deps, ctx, party); }
    else await scanCard(deps, ctx, party, String(as_of_date));
    // the payroll connector: a standing authorization refreshes the data under 32.11 §5 (flows/11 refreshStandingIncome orders through 22.3 and withdraws any pending connector card) — no card then (rule 4)
    if (!(await standingConsent(deps, party.party_id))) await sendCard(deps, ctx, party, { kind: "ConnectCard", copy_key: "income.connect.purpose", flow_key: `connect.income:${party.party_id}`, command_ref: "verification.connect",
      props: { vendor: "truv_income", purpose_text: "", what_we_get: ["employer", "start date", "pay frequency", "base and variable pay", "year-to-date"], fallback: { label: "Type your monthly income now; we'll ask for paystubs later", document_class: "paystub" }, state: "not_started", pre_intent_optional: true, vendor_fake: "FAKE", command_args: { vendor: "truv_income", component: "income", fee_paid_by: "sm", ...(lead_id ? { lead_id } : {}) } } });
    await sendCard(deps, ctx, party, { kind: "ConnectCard", copy_key: "assets.connect.purpose", flow_key: `connect.assets:${party.party_id}`,
      props: { vendor: "plaid_assets", purpose_text: "", what_we_get: ["balances", "twelve months of deposits"], fallback: { label: "Send two months of statements per account instead", document_class: "bank_statement" }, state: "not_started", pre_intent_optional: true, vendor_fake: "FAKE" } });
    // 32.11's masked "SSN on file" card assumes a prior application's SSN; a partner-book homeowner has none on file — the SSN is typed (rule 4), so the masked card is withdrawn
    if (!party.tin_last4) {
      const masked = await deps.runtime.db.query<{ card_instance_id: string }>(`SELECT card_instance_id FROM card_instances WHERE subject_application_id = $1 AND party_id = $2 AND copy_key = 'refi.ssn.confirm' AND status = 'pending'`, [ctx.appId, party.party_id]);
      for (const m of masked) await deps.ui.transitionCard(m.card_instance_id, "cancelled", "system", ctx.now, { reason: "no SSN on file for a partner-book homeowner — the SSN is typed on the identity.ssn card (33.3 rule 4)", resolved_by: "system:flow-33.3" });
    }
  }
}
/** 32.3 R1 after the scan: the identity ConfirmCard from the vendor's prefill, then the one typed field — the SSN card (32.18 rule 1) when nothing is on file. */
async function afterIdentity(deps: FlowDeps, ctx: AppCtx, e: DomainEvent): Promise<void> {
  const abId = s(pl(e)["borrower_id"]); const lead_id = leadIdOf(ctx);
  const prefillOf = (party: Party, key: string): { value: string; source: string } | null => { const p = party.prefill[key] as { value?: unknown; source?: unknown } | undefined; return p && p.value !== undefined && p.value !== null ? { value: String(p.value), source: typeof p.source === "string" ? p.source : "borrower" } : null; };
  for (const party of ctx.parties.filter((p) => !abId || p.application_borrower_id === abId)) {
    const name = prefillOf(party, "legal_name"); const dob = prefillOf(party, "date_of_birth"); const addr = prefillOf(party, "address") ?? prefillOf(party, "current_address");
    // 32.3 E5 (unchanged here): the residence basis and the months at the address are asked on every file — the tap writes the Current du_residences row through 23.5 writeResidence (the row's edge is application_borrower_id)
    const residence = RESIDENCE_FIELDS();
    if (name && dob && addr) await sendCard(deps, ctx, party, { kind: "ConfirmCard", copy_key: "identity.confirm.title", flow_key: `identity.confirm:${party.application_borrower_id}`, command_ref: "application.confirmField",
      props: { title: "", fields: [{ path: "legal_name", label: "Legal name", value: name.value, source: name.source }, { path: "date_of_birth", label: "Date of birth", value: dob.value, source: dob.source }, { path: "current_address", label: "Current address", value: addr.value, source: addr.source }, ...residence.fields], commits_to: "application_borrowers",
        required_paths: residence.required_paths, money_paths: residence.money_paths, required_when: residence.required_when, helper_copy_key: "identity.residence.why",
        command_args: { path: "identity", commits_to: "application_borrowers", application_borrower_id: party.application_borrower_id, ...(lead_id ? { lead_id } : {}) } } });
    await ssnCard(deps, ctx, party);
  }
}
/** The row read identity stale or missing on an open refinance application (rule 4 / the edge case): the scan card once more — never before the Yes (no application on the row), never while one is pending. */
async function reaskScan(deps: FlowDeps, ctx: AppCtx, e: DomainEvent): Promise<void> {
  const p = pl(e); const missing = Array.isArray(p["missing"]) ? (p["missing"] as unknown[]) : [];
  if (!missing.includes("identity") || ctx.loanStatus !== "monitored") return;
  const asOf = s(p["as_of_date"]) ?? String(asOfOf(ctx.now).as_of_date);
  const partyId = s(p["party_id"]);
  for (const party of ctx.parties.filter((x) => !partyId || x.party_id === partyId)) await scanCard(deps, ctx, party, asOf);
}

/** 32.3 R3 after the payroll connection: the income ConfirmCard as the FAKE Truv report shows it (from the ConnectCard's `evidence.report` by report reference — 3-entry's incomeCard, which `asksHere` gates out for a refi_trigger application); a standing refresh already carries its own card (flows/11 refreshStandingIncome, the same `income.confirm:<verification_id>` flow key). */
async function incomeCard(deps: FlowDeps, ctx: AppCtx, e: DomainEvent): Promise<void> {
  const p = pl(e); if (p["kind"] !== "income") return;
  const ref = String(p["report_reference_id"] ?? ""); const verificationId = String(p["verification_id"] ?? "");
  const rows = await deps.runtime.db.query<{ party_id: string; evidence: P | null; props: P }>(`SELECT party_id, evidence, props FROM card_instances WHERE subject_application_id = $1 AND kind = 'ConnectCard' AND (evidence->>'report_reference_id' = $2 OR props->>'report_reference_id' = $2) ORDER BY created_at DESC LIMIT 1`, [ctx.appId, ref]);
  const report = ((rows[0]?.evidence?.["report"] ?? rows[0]?.props["report"]) as P | undefined) ?? {};
  for (const party of ctx.parties.filter((x) => !rows[0] || x.party_id === rows[0].party_id)) {
    // a card for this report is already on the rail (the standing refresh's, or an earlier reaction's): nothing more
    const already = await deps.runtime.db.query(`SELECT 1 FROM card_instances WHERE subject_application_id = $1 AND party_id = $2 AND copy_key = 'income.confirm.title' AND (props->'command_args'->>'report_reference_id' = $3 OR props->>'flow_key' = $4)`, [ctx.appId, party.party_id, ref, `income.confirm:${verificationId || ref}`]);
    if (already.length) continue;
    const employer = String(report["employer"] ?? "your employer");
    await sendCard(deps, ctx, party, { kind: "ConfirmCard", copy_key: "income.confirm.title", flow_key: `income.confirm:${verificationId || ref}`, command_ref: "application.confirmField",
      props: { title: "", copy_tokens: { employer }, fields: [{ path: "employer", label: "Employer", value: employer, source: "payroll_connection" }, { path: "position", label: "Position", value: String(report["position"] ?? ""), source: "payroll_connection" }, { path: "start_date", label: "Start date", value: String(report["start_date"] ?? ""), source: "payroll_connection" }, { path: "pay_frequency", label: "Pay frequency", value: String(report["pay_frequency"] ?? ""), source: "payroll_connection" },
        { path: "monthly_base_cents", label: "Monthly base pay", value: String(report["monthly_base_cents"] ?? ""), source: "payroll_connection" }, { path: "monthly_variable_cents", label: "Monthly overtime, bonus, commission", value: String(report["monthly_variable_cents"] ?? "0"), source: "payroll_connection" }, { path: "other_income", label: "Other income (Social Security, pension, child support, rental)", value: "none", source: "borrower" }],
        commits_to: "application_income", money_paths: ["monthly_base_cents", "monthly_variable_cents"], affirmatives: ["that's my income", "thats my income", "yes that's my income", "that is my income", "my income is right"], statement: "This becomes the income you're stating on your application.",
        command_args: { path: "income", commits_to: "application_income", verification_id: verificationId, report_reference_id: ref } } });   // no lead_id: after 20.3's conversion 21.1 owns the six items (20.3 rule 6 keeps a lead's income to the pre-conversion statuses — flows/11 refreshStandingIncome)
  }
}

// ---------------------------------------------------------------- 32.18 rule 2 / rule 3 for the refinance application (3-entry's asksHere stands down for refi_trigger)
const exec = (deps: FlowDeps, appId: string, process: string, name: string, actor: Actor, input: P) => deps.runtime.execute({ process, name, loanId: "", applicationId: appId, actor, input, run: { ...RUN } });
/** The credit pull is the platform's, once: the six items in (trid_received), the SSN on file, the hard-pull authorization on the lead (32.17 rule 20 / the consent.credit card) — the same conditions as flows/3-entry.ts creditPull. */
async function creditPull(deps: FlowDeps, ctx: AppCtx): Promise<void> {
  if (has(ctx, "credit.report.ordered") || has(ctx, "credit.report.received")) return;
  if (!has(ctx, "application.trid_received")) return;
  const ssnOnFile = has(ctx, "application.six_item.captured", (x) => x["item"] === "ssn") || (await deps.runtime.db.query(`SELECT 1 FROM application_borrowers WHERE application_id = $1 AND tin_last4 IS NOT NULL`, [ctx.appId])).length > 0;
  if (!ssnOnFile) return;
  const authorizations = Array.isArray(ctx.lead?.["credit_authorizations"]) ? (ctx.lead!["credit_authorizations"] as P[]) : [];
  const authz = authorizations.filter((a) => a["kind"] === "hard_application").map((a) => String(a["authorization_id"])).at(-1);
  if (!authz) return;
  const borrower_ids = intakeBorrowerIds(ctx); if (!borrower_ids.length) return;
  try {
    const order = await exec(deps, ctx.appId, "22.2", "orderCreditReport", VERIFICATION, { application_id: ctx.appId, borrower_ids, ...CREDIT_ORDER, borrower_authorization_ref: authz, fee_sm_borne: true });
    const reportId = String((order.output as P)["report_id"]);
    await exec(deps, ctx.appId, "22.2", "parseCreditReport", VERIFICATION, { application_id: ctx.appId, report_id: reportId });
    deps.logger?.info("borrower.flow.33-3.credit.ordered", { application_id: ctx.appId, report_id: reportId, borrower_ids, authorization_id: authz });
  } catch (err) { deps.logger?.warn("borrower.flow.33-3.credit.refused", { application_id: ctx.appId, error: err instanceof Error ? err.message : String(err), code: (err as { code?: string }).code ?? null }); }
}
/** The DU moment: trid_received, a usable report, income on file, the assets card settled, no casefile yet → 32.18 underwriting.run once — the same conditions as flows/3-entry.ts duMoment. */
async function duMoment(deps: FlowDeps, ctx: AppCtx): Promise<void> {
  if (!has(ctx, "application.trid_received")) return;
  if (has(ctx, "du.casefile.created") || has(ctx, "du.submitted")) return;
  const report = ctx.store.list("credit_reports", (d) => d["application_id"] === ctx.appId && d["state"] === "usable").at(-1); if (!report) return;
  const intake = ctx.store.get("applications", ctx.appId)?.data as P | undefined;
  const incomeOnFile = (await deps.runtime.db.query(`SELECT 1 FROM application_income WHERE application_id = $1`, [ctx.appId])).length > 0 || has(ctx, "verification.received", (x) => x["kind"] === "income") || (typeof intake?.["income_monthly_cents"] === "string" && intake["income_monthly_cents"] !== "");
  if (!incomeOnFile) return;
  const assetsPending = (await deps.runtime.db.query(`SELECT 1 FROM card_instances WHERE subject_application_id = $1 AND kind = 'ConnectCard' AND props->>'vendor' = 'plaid_assets' AND status = 'pending'`, [ctx.appId])).length > 0;
  if (assetsPending) return;
  try {
    const r = await exec(deps, ctx.appId, "32.18", "underwriting.run", BORROWER_APP, { application_id: ctx.appId });
    deps.logger?.info("borrower.flow.33-3.du.ran", { application_id: ctx.appId, ...(r.output as P), events: r.events.map((e) => e.type) });
  } catch (err) { deps.logger?.warn("borrower.flow.33-3.du.refused", { application_id: ctx.appId, error: err instanceof Error ? err.message : String(err), code: (err as { code?: string }).code ?? null }); }
}

// ---------------------------------------------------------------- rule 4: the readiness row on every triggering event
/** `identity.verified`, `credit.report.received`, `verification.received{income|assets}`, the consents, the hard-pull authorization, the typed SSN, `income.validated`. */
const READINESS_TRIGGERS = new Set(["identity.verified", "credit.report.received", "verification.received", "consent.captured", "consent.granted", "consent.esign.active", "credit.authorization.captured", "application.six_item.captured", "income.validated"]);
const triggersReadiness = (e: DomainEvent): boolean => {
  if (!READINESS_TRIGGERS.has(e.type)) return false;
  const p = pl(e);
  if (e.type === "verification.received") return p["kind"] === "income" || p["kind"] === "assets";
  if (e.type === "application.six_item.captured") return p["item"] === "ssn";
  return true;
};
async function checkReadiness(deps: FlowDeps, loanId: string, partyId: string, appId: string | null, why: string): Promise<void> {
  const now = deps.runtime.clock.now();
  try {
    const r = await readinessCheck(deps.runtime, { loan_id: loanId, party_id: partyId, application_id: appId, ...asOfOf(now) });
    deps.logger?.info("borrower.flow.33-3.readiness.checked", { loan_id: loanId, party_id: partyId, application_id: appId, readiness_check_id: r.id, ready: r.ready, missing: r.missing, trigger: why });
  } catch (err) { deps.logger?.error("borrower.flow.33-3.readiness.failed", { loan_id: loanId, party_id: partyId, application_id: appId, trigger: why, error: err instanceof Error ? err.message : String(err) }); }
}

// ---------------------------------------------------------------- rule 3: the Yes on a monitored loan
async function onEngaged(deps: FlowDeps, loanId: string, e: DomainEvent): Promise<void> {
  const p = pl(e); const opportunity_id = s(p["opportunity_id"]); const lead_id = s(p["lead_id"]);
  const status = (await deps.runtime.db.query<{ status: string }>(`SELECT status::text AS status FROM loans WHERE id = $1`, [loanId]))[0]?.status ?? null;
  if (status !== "monitored") return;   // a serviced loan's Yes converts under 32.11 (flows/11-rate-watch convert); a paid-off loan has no refinance to open
  if (!opportunity_id || !lead_id) { deps.logger?.warn("borrower.flow.33-3.engaged.incomplete", { loan_id: loanId, event_id: e.id }); return; }
  try {
    const r = await refiOpen(deps.runtime, { loan_id: loanId, opportunity_id, lead_id, engaged: e }, deps);
    deps.logger?.info("borrower.flow.33-3.refi_open", { loan_id: loanId, opportunity_id, lead_id, application_id: r.application_id, created: r.created });
    // the first readiness row with the application (rule 4: recomputed from now on at every verification event)
    const party = (await deps.runtime.db.query<{ party_id: string }>(`SELECT party_id::text AS party_id FROM application_borrowers WHERE application_id = $1 AND party_id IS NOT NULL ORDER BY (borrower_role::text = 'borrower') DESC, created_at LIMIT 1`, [r.application_id]))[0]?.party_id ?? null;
    if (party) await checkReadiness(deps, loanId, party, r.application_id, "refi.open");
  } catch (err) {
    if (err instanceof RefiOpenRefused) deps.logger?.warn("borrower.flow.33-3.refi_open.refused", { loan_id: loanId, opportunity_id, lead_id, code: err.code, reason: err.message });
    else deps.logger?.error("borrower.flow.33-3.refi_open.failed", { loan_id: loanId, opportunity_id, lead_id, error: err instanceof Error ? err.message : String(err) });
  }
}

// ---------------------------------------------------------------- rule 5: the refinance funded → the monitored loan paid off; rows stop
// (35.10: the retirement is the closeout's — `partner_book.loan.paid_off` is emitted by closeout.retire with this payload, and the status is the 35.1
// projector's on `refinance.prior_loan.retired{mode: monitored_partner}`; this flow only stops writing readiness rows once the loan is no longer monitored)
export const PAID_OFF_PAYLOAD_KEYS = ["loan_id", "application_id", "new_loan_id", "funding_date", "disbursement_date", "servicing_loan_number", "funded_event", "funded_event_id", "prior_status", "status", "origination"] as const;

// ---------------------------------------------------------------- the reactions
const LOAN_EVENTS = new Set(["refi.opportunity.engaged"]);
const APP_EVENTS = new Set(["application.received", "identity.verified", "credit.report.received", "verification.received", "consent.captured", "consent.granted", "consent.esign.active", "credit.authorization.captured", "application.six_item.captured", "income.validated", "loan.boarded", "loan.funded", "partner_book.readiness.checked"]);
async function reactApp(deps: FlowDeps, ctx: AppCtx, e: DomainEvent): Promise<void> {
  const p = pl(e);
  switch (e.type) {
    case "application.received": await authenticateLead(deps, ctx); await connectorCards(deps, ctx); return;
    case "identity.verified": await afterIdentity(deps, ctx, e); return;
    case "credit.authorization.captured": await creditPull(deps, ctx); return;
    case "application.six_item.captured": if (p["item"] === "ssn") await creditPull(deps, ctx); if (p["item"] === "income") await duMoment(deps, ctx); return;
    case "verification.received": await incomeCard(deps, ctx, e); await duMoment(deps, ctx); return;   // 32.3 R3's income card, then 32.18 rule 3: the income or the assets report may be the last prerequisite
    case "loan.boarded": case "loan.funded": return;   // 35.10: the closeout retires the prior loan on the sweep (closeout.retire); nothing to do here
    case "partner_book.readiness.checked": await reaskScan(deps, ctx, e); return;
    default: return;
  }
}

export const FLOW_16_READINESS: BorrowerFlow = {
  id: FLOW_ID,
  reacts: (type) => LOAN_EVENTS.has(type) || APP_EVENTS.has(type),
  async onEvents(deps, events) {
    const byLoan = new Map<string, DomainEvent[]>(); const byApp = new Map<string, DomainEvent[]>();
    for (const e of events) {
      if (LOAN_EVENTS.has(e.type)) { const loan = e.loanId ?? s(pl(e)["loan_id"]); if (loan) { const l = byLoan.get(loan) ?? []; l.push(e); byLoan.set(loan, l); } }
      if (APP_EVENTS.has(e.type)) { const app = e.applicationId ?? s(pl(e)["application_id"]); if (app) { const l = byApp.get(app) ?? []; l.push(e); byApp.set(app, l); } }
    }
    for (const [loanId, list] of byLoan) for (const e of list) { try { await onEngaged(deps, loanId, e); } catch (err) { deps.logger?.error("borrower.flow.33-3.reaction", { event: e.type, loan_id: loanId, error: err instanceof Error ? err.message : String(err) }); } }
    for (const [appId, list] of byApp) {
      const ctx = await appContext(deps, appId);
      if (!ctx || !ctx.parties.length) continue;   // only a refinance application from a monitored loan with a linked party is this flow's
      // rule 5: 30.2 commits loan.funded and loan.boarded together — the boarded event (it names the new loan) is the one acted on when both are here
      const boarded = list.some((e) => e.type === "loan.boarded");
      for (const e of list) { if (e.type === "loan.funded" && boarded) continue; try { await reactApp(deps, ctx, e); } catch (err) { deps.logger?.error("borrower.flow.33-3.reaction", { event: e.type, application_id: appId, error: err instanceof Error ? err.message : String(err) }); } }
      // rule 4: one readiness row per application per settlement, after the batch's own writes — for a loan still monitored (rule 5: rows stop once the refinance funded)
      const trigger = list.find(triggersReadiness);
      if (trigger && ctx.loanStatus === "monitored") await checkReadiness(deps, ctx.loanId, ctx.parties[0]!.party_id, ctx.appId, trigger.type);
    }
  },
};
