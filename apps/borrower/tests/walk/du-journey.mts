/**
 * The DU-side verdict of the deploy walk (demo-walk.mts outcomes 3 and 5 — the DU moment reached from the Apply screens; the
 * screens are driven by apply-journey.mts) read through the ops API: `duVerdict` and `waitForDuMoment`. `driveToDuMoment` is the
 * API-only journey (the taps and the FAKE connector sessions, never a message to the model) the old twelfth outcome ran and a dry
 * run against a local API can still use.
 *
 * The journey is src/domain/borrower/32-18.spec.test.ts's `toDu` helper (signedUpWithGoal / identity / typeSsn / home /
 * income / assets / aboutYouAndSixItems) restated over an `ApiFn`, so the same steps run through the page's same-origin
 * proxy on the deployed demo (demo-walk.mts `apiOnPage`) and against a local API server with a bearer token (the dry run).
 * The deployed flows react asynchronously: every step polls the pending cards for the copy key it needs, with a bounded
 * timeout, and fails naming the card it was waiting for and the pending ones it saw. Nothing here passes by default.
 *
 * Copied, not imported (this file runs from apps/borrower against a deployed demo): the fixture values of 32-18.spec.test.ts
 * (the address, the DOB, the SSN, the value and the amount) and src/domain/borrower/eval/personas.ts REFINANCE_PROFILE.
 */
export type Json = Record<string, unknown>;
export type ApiAnswer = { status: number; body: Json };
export type ApiFn = (method: "GET" | "POST", path: string, body?: Json) => Promise<ApiAnswer>;
export type Card = { card_instance_id: string; kind: string; status: string; copy_key: string; props: Json };
export type JourneyOptions = { timeoutMs?: number; pollMs?: number; log?: (line: string) => void; now?: () => string };

/** A step that could not be taken, with the reason the report shows. */
export class JourneyError extends Error {
  readonly step: string;
  constructor(step: string, reason: string) { super(`${step}: ${reason}`); this.name = "JourneyError"; this.step = step; }
}

/** The walk's fixed identity: the account is created with an e-mail and a password only, so the name and the birth date are edited on the identity card (32.18 rule 7: the legal name is what the document's FirstName / LastName come from). */
export const WALK_NAME = "Walk Tester";
export const WALK_DOB = "1988-04-12";
export const ADDRESS = "100 N Central Ave, Phoenix, AZ 85004";
export const SSN = "123-45-6789";
export const PROPERTY_VALUE_CENTS = "80000000";
export const LOAN_AMOUNT_CENTS = "56000000";
export const REFINANCE_PROFILE: readonly { path: string; value: string }[] = [{ path: "citizenship_status", value: "us_citizen" }, { path: "marital_status", value: "unmarried" }, { path: "dependents", value: "0" }, { path: "military_service", value: "none" }, { path: "language_preference", value: "english" }];
/** The taps in order — the log line of each step and the copy key the step waits for. */
export const JOURNEY_STEPS = ["entry.goal.question", "identity.stripe.purpose", "identity.confirm.title", "identity.ssn.title", "refi.home.confirm", "income.connect.purpose", "income.confirm.title", "assets.connect.purpose", "profile.title", "declarations.occupancy", "declarations.clean_energy_lien", "declarations.title", "demographics.title", "refi.value.confirm", "refi.loan_amount.confirm", "refi.product.choice"] as const;

const short = (v: unknown, n = 400): string => JSON.stringify(v ?? null).slice(0, n);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The pending cards as the thread read model lists them (`cards` — every pending card of the party, the current ask first). */
export async function pendingCards(api: ApiFn): Promise<Card[]> {
  const t = await api("GET", "/v1/borrower/thread?limit=500");
  if (t.status !== 200) throw new JourneyError("thread", `GET /v1/borrower/thread answered ${t.status}: ${short(t.body)}`);
  return (Array.isArray(t.body["cards"]) ? (t.body["cards"] as Card[]) : []).filter((c) => c.status === "pending");
}

/** Poll until a pending card with `copyKey` exists; on the timeout, the card waited for and the pending copy keys seen. */
export async function waitForCard(api: ApiFn, copyKey: string, o: JourneyOptions = {}): Promise<Card> {
  const timeout = o.timeoutMs ?? 90_000; const poll = o.pollMs ?? 1000; const started = Date.now();
  let seen: string[] = [];
  for (;;) {
    const cards = await pendingCards(api);
    const hit = cards.filter((c) => c.copy_key === copyKey).at(-1);
    if (hit) return hit;
    seen = cards.map((c) => c.copy_key);
    if (Date.now() - started >= timeout) throw new JourneyError(`wait ${copyKey}`, `no pending ${copyKey} card after ${Math.round((Date.now() - started) / 1000)}s (pending: ${seen.length ? seen.join(", ") : "none"})`);
    await sleep(poll);
  }
}

/** The evidence a ConfirmCard's tap carries: every field of the card as shown, `edits` overriding by path (32-18.spec.test.ts fieldsEvidence). */
export const fieldsEvidence = (card: Card, edits: Record<string, string>, now: string): Json => {
  const fields = Array.isArray(card.props["fields"]) ? (card.props["fields"] as { path: string; value?: string; source?: string }[]) : [];
  return { evidence: { fields: fields.map((f) => ({ path: f.path, value_confirmed: edits[f.path] ?? f.value ?? "", source: f.source ?? "borrower", confirmed_at: now })), edited: Object.keys(edits).length > 0 } };
};

export async function tap(api: ApiFn, card: Card, body: Json, o: JourneyOptions = {}): Promise<ApiAnswer> {
  const r = await api("POST", `/v1/borrower/cards/${card.card_instance_id}/resolve`, body);
  if (r.status !== 201) throw new JourneyError(`tap ${card.copy_key}`, `POST /cards/{id}/resolve answered ${r.status}: ${short(r.body)}`);
  o.log?.(`tapped ${card.copy_key}`);
  return r;
}

/** The party's application: the subject GET /v1/borrower/me lists with an application_id (opened by the goal's tap — polled, the flows react asynchronously). */
export async function applicationId(api: ApiFn, o: JourneyOptions = {}): Promise<string> {
  const timeout = o.timeoutMs ?? 90_000; const started = Date.now();
  for (;;) {
    const me = await api("GET", "/v1/borrower/me");
    if (me.status !== 200) throw new JourneyError("me", `GET /v1/borrower/me answered ${me.status}: ${short(me.body)}`);
    const subjects = Array.isArray(me.body["subjects"]) ? (me.body["subjects"] as Json[]) : [];
    const app = subjects.find((s) => typeof s["application_id"] === "string" && s["application_id"]);
    if (app) return app["application_id"] as string;
    if (Date.now() - started >= timeout) throw new JourneyError("me", `no application subject on GET /v1/borrower/me after ${Math.round((Date.now() - started) / 1000)}s (subjects: ${short(subjects)})`);
    await sleep(o.pollMs ?? 1000);
  }
}

/**
 * The whole journey from a signed-in fresh account to the DU moment, over the API: the goal tap (lower_rate), the ID scan finishing on
 * the tap (FAKE, `fake_complete`), the identity confirmed with the walk's name and birth date edited in and the residence basis (own, 72 months — no
 * prior-residence card), the SSN, the home with its two asked facts (the estate, the clean-energy lien — 32.18 rule 7), the payroll connection and the income confirmed as shown, the assets connection, the profile, the occupancy card then the
 * declarations "none", the demographics, the value, the loan amount and the product. Returns the application id and the taps made.
 */
export async function driveToDuMoment(api: ApiFn, o: JourneyOptions = {}): Promise<{ application_id: string; taps: string[] }> {
  const now = o.now ?? (() => new Date().toISOString());
  const taps: string[] = [];
  const log = (line: string): void => { o.log?.(line); };
  const opts: JourneyOptions = { ...o, log: (line) => { if (line.startsWith("tapped ")) taps.push(line.slice(7)); log(line); } };
  const confirm = async (copyKey: string, edits: Record<string, string> = {}): Promise<void> => { const card = await waitForCard(api, copyKey, opts); await tap(api, card, fieldsEvidence(card, edits, now()), opts); };
  const choose = async (copyKey: string, optionId: string): Promise<void> => { const card = await waitForCard(api, copyKey, opts); await tap(api, card, { option_id: optionId, evidence: { option_id: optionId, tapped_at: now() } }, opts); };

  // the goal (32.17 rule 20: the tap writes the hard-pull authorization; the application opens)
  await choose("entry.goal.question", "lower_rate");
  const application_id = await applicationId(api, opts);
  log(`application ${application_id}`);
  // E5: the ID scan on the FAKE finishing on the tap (routes.ts identitySession, fake_complete), then the identity ConfirmCard with the residence basis
  await waitForCard(api, "identity.stripe.purpose", opts);
  const vs = await api("POST", "/v1/borrower/identity/stripe/session", { application_id, fake_complete: true });
  if (vs.status !== 200) throw new JourneyError("identity session", `POST /v1/borrower/identity/stripe/session answered ${vs.status}: ${short(vs.body)}`);
  if (vs.body["status"] !== "verified") throw new JourneyError("identity session", `the FAKE did not finish on the tap (status=${String(vs.body["status"])}, delivery=${String(vs.body["delivery"])}): ${short(vs.body)}`);
  taps.push("identity.stripe.purpose");
  await confirm("identity.confirm.title", { legal_name: WALK_NAME, date_of_birth: WALK_DOB, residency_basis: "own", months_at_address: "72" });
  await confirm("identity.ssn.title", { ssn: SSN });
  await confirm("refi.home.confirm", { property_address: ADDRESS, estate_type: "fee_simple", existing_clean_energy_lien: "no" });
  // R3: the payroll connection on the FAKE, then the income as the report shows it
  const incomeCard = await waitForCard(api, "income.connect.purpose", opts);
  const inc = await api("POST", "/v1/borrower/connect/truv_income/session", { card_instance_id: incomeCard.card_instance_id, fake_complete: true });
  if (inc.status !== 200 || inc.body["outcome"] !== "connected") throw new JourneyError("income session", `POST /v1/borrower/connect/truv_income/session answered ${inc.status} outcome=${String(inc.body["outcome"])}: ${short(inc.body)}`);
  taps.push("income.connect.purpose");
  await confirm("income.confirm.title");
  // 32.18 rule 1: the assets connection on the FAKE
  const assetsCard = await waitForCard(api, "assets.connect.purpose", opts);
  const as = await api("POST", "/v1/borrower/connect/plaid_assets/session", { card_instance_id: assetsCard.card_instance_id, fake_complete: true });
  if (as.status !== 200 || as.body["outcome"] !== "connected") throw new JourneyError("assets session", `POST /v1/borrower/connect/plaid_assets/session answered ${as.status} outcome=${String(as.body["outcome"])}: ${short(as.body)}`);
  taps.push("assets.connect.purpose");
  // R4–R7: the profile, 5a.A and 5a.E then the declarations list, the demographics
  const profile = await waitForCard(api, "profile.title", opts);
  await tap(api, profile, { option_id: "submit", evidence: { fields: REFINANCE_PROFILE.map((x) => ({ path: x.path, value: x.value, answered_at: now() })) } }, opts);
  await choose("declarations.occupancy", "yes_no_prior");
  await choose("declarations.clean_energy_lien", "no");   // 5a.E on its own card (32.3 R5)
  await choose("declarations.title", "none");
  const demo = await waitForCard(api, "demographics.title", opts);
  await tap(api, demo, { option_id: "submit", evidence: { collection_method: "internet", answered_at: now(), answers: { ethnicity: ["do_not_wish"], race: ["do_not_wish"], sex: "do_not_wish" } } }, opts);
  // the six items' last cards: the value, the amount, the product (the product card is sent with the amount's; it is tapped when it is there)
  await confirm("refi.value.confirm", { property_value_estimate: PROPERTY_VALUE_CENTS });
  await confirm("refi.loan_amount.confirm", { loan_amount_sought: LOAN_AMOUNT_CENTS });
  try { await choose("refi.product.choice", "FRM30"); }
  catch (e) { if (!(e instanceof JourneyError)) throw e; log(`no product card to tap (${e.message}) — the DU moment must follow without it or the verdict fails`); }
  return { application_id, taps };
}

// ───────────────────────────── the DU-side verdict, read from the ops record (GET /v1/applications/{id} → runtime.applicationRecord())
export type OpsEvent = { type: string; payload?: Json };
export type OpsRecord = { application?: Json; events?: OpsEvent[]; du?: { documents?: Json[]; preflight?: Json[] } };
export type DuVerdict = { ok: boolean; missing: string[]; seen: string[]; detail: string };

/** What the DU moment must have left on the record; every absence named, the du.* events seen listed. */
export function duVerdict(rec: OpsRecord): DuVerdict {
  const events = Array.isArray(rec.events) ? rec.events : [];
  const seen = events.map((e) => e.type).filter((t) => t.startsWith("du."));
  const missing: string[] = [];
  const emitted = events.find((e) => e.type === "du.document.emitted");
  const documents = Array.isArray(rec.du?.documents) ? rec.du!.documents! : [];
  if (!emitted) missing.push("event du.document.emitted");
  const duDocumentId = typeof emitted?.payload?.["du_document_id"] === "string" ? (emitted.payload["du_document_id"] as string) : "";
  const sha = typeof emitted?.payload?.["sha256"] === "string" ? (emitted.payload["sha256"] as string) : "";
  const row = documents.find((d) => d["id"] === duDocumentId);
  if (emitted && !duDocumentId) missing.push("du.document.emitted payload du_document_id");
  if (emitted && !sha) missing.push("du.document.emitted payload sha256");
  if (emitted && duDocumentId && !row) missing.push(`du_documents row ${duDocumentId} (the record lists ${documents.length})`);
  if (row && sha && row["sha256"] !== sha) missing.push(`du_documents row sha256 = the event's (${String(row["sha256"])} vs ${sha})`);
  // 32.18 rule 7 / 23.6: the document must name no required data point as missing — 23.7's gate holds one that does, so the journey must have supplied every borrower fact and the platform derived the rest
  const requiredMissing = emitted?.payload?.["required_missing"] ?? row?.["required_missing"];
  if (emitted && Number(requiredMissing) !== 0) missing.push(`du.document.emitted required_missing = 0 (got ${String(requiredMissing ?? "n/a")}; gaps: ${JSON.stringify(emitted.payload?.["gaps"] ?? []).slice(0, 300)})`);
  for (const t of ["du.submitted", "du.findings.received"]) if (!events.some((e) => e.type === t)) missing.push(`event ${t}`);
  // 23.7's preflight runs on the emission (23.1 buildDuRequest): `du.preflight.passed` on the bus (or `du.preflight.refused{code, xpath, rule}` when it did not pass) and the du_preflight_results row behind it, listed on the record's `du.preflight`; the walk asserts the pass, by name
  const refused = events.find((e) => e.type === "du.preflight.refused");
  if (!events.some((e) => e.type === "du.preflight.passed")) missing.push(refused ? `event du.preflight.passed (du.preflight.refused: ${JSON.stringify(refused.payload ?? {}).slice(0, 200)})` : "event du.preflight.passed");
  const preflightRows = Array.isArray(rec.du?.preflight) ? rec.du!.preflight! : [];
  if (!preflightRows.some((p) => p["passed"] === true)) missing.push(`a du_preflight_results row with passed = true (the record lists ${preflightRows.length})`);
  // 23.7 rule 9: the FAKE DU port's ack mints a ten-digit casefile id, written once to applications.du_casefile_id (migration 0133) from the first ack
  const casefileId = rec.application?.["du_casefile_id"];
  if (typeof casefileId !== "string" || !casefileId) missing.push("application.du_casefile_id (empty)");
  else if (!/^\d{10}$/.test(casefileId)) missing.push(`application.du_casefile_id ten digits (got ${JSON.stringify(casefileId)})`);
  const detail = `du events seen: [${seen.join(", ")}]; du_documents: ${documents.length}${row ? ` (row ${duDocumentId} sha256 ${String(row["sha256"]).slice(0, 12)}…, required_missing ${String(row["required_missing"])})` : ""}; preflight rows: ${Array.isArray(rec.du?.preflight) ? rec.du!.preflight!.length : "n/a"}; du_casefile_id=${JSON.stringify(casefileId ?? null)}`;
  return { ok: missing.length === 0, missing, seen, detail: missing.length ? `missing: ${missing.join("; ")} — ${detail}` : detail };
}

/** Poll the ops record until `du.findings.received` is on it (the DU moment runs after the last tap, asynchronously) or the timeout passes; the last record read either way. */
export async function waitForDuMoment(readRecord: () => Promise<OpsRecord>, o: JourneyOptions = {}): Promise<OpsRecord> {
  const timeout = o.timeoutMs ?? 180_000; const started = Date.now();
  let rec = await readRecord();
  while (!(rec.events ?? []).some((e) => e.type === "du.findings.received") && Date.now() - started < timeout) { await sleep(o.pollMs ?? 2000); rec = await readRecord(); }
  return rec;
}
