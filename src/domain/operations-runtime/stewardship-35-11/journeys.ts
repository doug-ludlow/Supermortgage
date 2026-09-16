/**
 * §35.11 rule 11 — the journey declarations the persisted count reads: which journey test files ran, and the tables each of their
 * steps writes (`expected`). A journey is a `node:test` file that drives a lifecycle through the hosted API on its own database
 * (src/infra/db/test-db.ts gives each file one, named from its path and the checkout root; the harness drops it when the file's
 * process exits unless KEEP_TEST_DB=1 — tools/persisted-count.ts runs the journeys with it set (PERSISTED_RUN_JOURNEYS=1) and reads
 * their rows before dropping them). `expected` is true for a manifest table a step names here; `sections_complete` lists every section all of whose
 * expected tables are `persisted` (and no projection gap for the run).
 *
 * The two lifecycle journeys declare theirs here (the tables their steps commit through the bus: the sections' own DDL, by name);
 * the §35 journeys — 35.5's daily cashiering year, 35.6's closing and funding, 35.9's default timeline, 35.10's refinance close —
 * own their slots below and fill them when they land (an empty `steps` list is "not measured", never "failed": the spec's open
 * question 4). A caller may pass its own declarations to `audit.persisted.count{journeys}`.
 */
export interface JourneyStep { readonly step: string; readonly writes: readonly string[] }
export interface JourneyDeclaration { readonly name: string; readonly steps: readonly JourneyStep[]; /** an explicit database (a test's own); otherwise the harness name derived from the file */ readonly database_url?: string }

export const JOURNEY_WRITES: readonly JourneyDeclaration[] = [
  // the two lifecycle journeys' writes, measured on their harness databases (a table a step drives in memory without a row of its own is not declared)
  { name: "lifecycle.test.ts", steps: [
    { step: "a1-a6 the lead, the 1003 interview, the quote, the LE, the intent and the lock (application scope)", writes: ["applications", "application_borrowers", "loan_events", "timers", "agent_decisions", "entity_records"] },
    { step: "a7-a9 verifications, the valuation, DU and the decision", writes: ["du_documents", "escalations"] },
    { step: "a10-a13 the closing, the CD, the documents, consummation and funding", writes: ["documents"] },
    { step: "b-c the boarding of the funded loan and the servicing hand-off", writes: ["loans", "ledger_lines", "loan_events", "timers"] },
  ] },
  { name: "purchase-lifecycle.test.ts", steps: [
    { step: "purchase a-e the lead, the application, identity, the intent, the appraisal and the commitment", writes: ["applications", "application_borrowers", "loan_events", "timers", "entity_records"] },
    { step: "purchase f-g the eNote set, consummation and the funding that boards the loan", writes: ["loans", "ledger_lines", "documents"] },
    { step: "purchase h the cards of the borrower flows", writes: ["card_instances", "messages"] },
  ] },
  { name: "35-5.spec.test.ts", steps: [] },
  { name: "35-6.spec.test.ts", steps: [] },
  { name: "35-9.spec.test.ts", steps: [] },
  { name: "35-10.spec.test.ts", steps: [] },
];
