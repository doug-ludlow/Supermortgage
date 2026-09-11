# 14 — Claude Code build plan

## 1. Where things live

```
docs/ux/                          ← this package (00–14)
docs/servicing/                   ← Subservicing Build Spec v1.0 (baseline, sections 1–19, verification report)
docs/origination/                 ← Origination Build Spec v1.0 (addendum, inventory, sections O1–O12, timer registry)
packages/borrower-app/            ← Next.js App Router (this package's target; absorbs borrower-portal)
  app/                            ← routes: /, /return/[vendor]/[card], /d/[token], /doc/[id]
  components/shell/               ← Thread, Record, ActionBar, StatusStrip, Drawer
  components/cards/               ← one component per CardKind (01 §3), typed from schemas
  components/record/              ← the ten Record sections
  lib/copy/                       ← 12-message-copy-library as typed keys
  lib/theme/                      ← tokens (01 §2), light set
  lib/api/                        ← generated client from api OpenAPI; SSE client
  tests/                          ← component, e2e (Playwright), copy tests
packages/api/                     ← add: borrower projections (02 §1), command endpoints (02 §2, §7), SSE (02 §3), UI-owned tables (02 §1.6)
packages/agents/borrower-comms/   ← add: card-sending tools (send_card, resolve_card_by_evidence), deep-link tool
packages/agents/intake/           ← add: the same tools; six-item confirmation events surfaced via cards
packages/integrations/            ← add: stripe-identity, plaid, truv, irs-ives, carrier-connect (optional), property-data (DELTA-03), ron-platform (exists under O7.2's eClosing adapter)
```

## 2. Build stages

Each stage ends with its tests green (13) and a demo script.

**UX-0 · Foundations (Stage O-1 / servicing Stage 1 parallel).** Shell + breakpoints + dark tokens; card library with schemas and evidence persistence; UI-owned tables; `borrower_record` projection and SSE; command endpoints with gate errors by `copy_key`; auth L1–L3 (OTP, passkeys, Stripe Identity webhook); deep links; copy library loader; telemetry. Tests: component suite, T-X-02…05, T-X-09…11.

**UX-1 · Entry and the 5-minute qualification (03).** E1–E6, R1–R12, P1–P9, C1–C7 against sandbox DU/credit/Truv/Plaid/Stripe; the MLO review queue as a state (`assisted`); preapproval object (DELTA-01). Tests: T-03-01…30.

**UX-2 · Disclosures through clear to close (04, 05, 06).** LE/companion `DocumentCard`s and receipt evidence; intent; lock lifecycle; revised LE diff; needs list from `conditions` + `document_requests`; uploads and classification; explanations; co-borrower threads; decision notices; valuation, project, title, insurance, MI cards. Tests: T-04, T-05, T-06.

**UX-3 · CD to boarding (07).** CD receipt and earliest-consummation dates; closing scheduling with the RON adapter; session states; rescission cards and exercise; funding status; boarding cards (first-payment letter, autopay, e-delivery, initial escrow statement, Fannie Mae letter). Tests: T-07.

**UX-4 · Servicing (08a, 08b, 08c).** Loan home and account states; payments/autopay; statements and 1098; escrow analysis and elections; insurance and FPI; PMI; ARM; life events and successors; requests (Intake Router wiring); hardship cadence and loss-mitigation cards; bankruptcy and foreclosure states. Tests: T-08a/b/c.

**UX-5 · Rate-watch, re-refinance, exits (09, 10).** Rate-watch block; `OfferCard` and consent-gated channels; conversion with `servicing_record` prefill; same-servicer payoff and escrow credit; standing connections (DELTA-05); payoff, lien release, transfer-out, successor, liquidation. Tests: T-09, T-10.

**UX-6 · Hardening.** Accessibility audit; copy tests; reading level; degraded modes; performance budgets (first card ≤ 1.5 s on 4G; SSE reconnect); security review (CSP, signed URLs, PII masking); light theme tokens.

## 3. Backend deltas the UX requires (declare, don't invent)

Claude Code creates these only as listed; anything else missing is reported back, not improvised.

| ID | Delta | Owner spec touched | Notes |
|---|---|---|---|
| DELTA-01 | Reg C **preapproval program**: `prequalifications{kind=preapproval, du_casefile_id, approved_amount_cents, valid_until}`; event `preapproval.letter.issued`; O2.6 adverse-action and O9.3 HMDA paths for denied preapproval requests | O1.3 (Q2 overridden), O2.6, O4.1 (TBD casefiles), O9.3 | 03 §3 |
| DELTA-02 | **UI-owned tables**: `conversations`, `messages`, `card_instances` (+events), `deep_links`, `ui_events`, `sessions` | none (new schema in borrower-app) | 02 §1.6 |
| DELTA-03 | **Property-data adapter** (`integrations/property-data`): public records (type, units, year built, APN, tax amount, HOA presence, owner of record, recorded liens), AVM; used by R1/P9/C1 | O1.3 (the "platform's estimate"), O5.4 (recorded instrument), O11.3 (tax lines) | 03 §2 R1 |
| DELTA-04 | **Carrier connection** (`integrations/carrier-connect`) — optional path for insurance evidence | O5.5, 9.1 | 06 §5, 08b §1 |
| DELTA-05 | **Standing verification connections**: `consents{kind=blanket_verification_authorization, standing=true}` with refresh/retention policy; Truv/Plaid connections kept live under authorization | O3.3, O3.4, O12.3 | 09 §5 |
| DELTA-06 | **Record projection** `borrower_record` and the servicing history views as read models in `api`; SSE stream | api | 02 §1, §3 |
| DELTA-07 | **Agent tools** `send_card`, `resolve_card_by_evidence` (voice intent, human-agent sends) and `create_deep_link` on `borrower-comms` and `intake` | baseline §8 tool allowlists | 01 §3, §6 |
| DELTA-08 | **Card-delivered notices**: Notice Registry channel `esign_portal` records `card_instance_id` as delivery evidence alongside `notices.rendered_document_id` | baseline §6 | 01 §3.6, 3.16 |
| DELTA-09 | **DemographicsCard collection_method** value `internet` recorded per §1002.13 / App. B for app sessions; `video` treated as not in person | O2.1 rule 3 | 03 R6 |
| DELTA-10 | **Per-listing estimate** for preapproved borrowers (P9): a `pricing_quotes` re-presentation under an approved quote id without a new MLO review while `SM_QUOTE_VALIDITY_GATE` is open | O1.4, O1.3 | 03 §3 P9 |

Open legal positions the UX carries as flags (not deltas): `origination.ai_mlo_intake` (O1.3 Q3), `live_contact.ai_voice_counts` (11.1), same-creditor rescission exemption (O6.3), Reg C preapproval adoption (DELTA-01 decision).

## 4. Prompts

### 4.1 Session start (UX-0)
> Read docs/ux/00-MASTER-INDEX.md, 01-foundations.md and 02-data-contracts.md in full; then docs/servicing/01-architecture-baseline.md and docs/origination/01-architecture-baseline-addendum.md. Build `packages/borrower-app` as the single borrower surface: the Thread/Record/ActionBar shell with the breakpoints and dark tokens in 01 §1–2; every card kind in 01 §3 as a typed component whose props are validated against the schema and whose resolution posts to `/v1/borrower/cards/{id}/resolve`; the Record sections in 01 §4 rendered from `borrower_record`. In `packages/api`, add the UI-owned tables (02 §1.6), the `borrower_record` projection and SSE (02 §1, §3), and the command endpoints in 02 §2/§7 returning `{code, gate, copy_key}` on refusal. Never invent a state, timer, notice, command or table: if a name you need is not in the build specs or in 02, stop and append it to `docs/ux/BACKEND-DELTAS.md` with the reason. Load copy only from `lib/copy` generated from 12-message-copy-library.md. Write the component tests and T-X-02…05, T-X-09…11 from 13-acceptance-tests.md. Report the delta list before writing any schema outside 02 §1.6.

### 4.2 Per-stage (UX-1 … UX-5)
> Read docs/ux/{file}.md in full and the build-spec sections it names in its header. For each screen/state: implement the cards and Record behavior exactly as specified (Reads · Commands · Events · Timers · Documents · Evidence · Roles · Copy); wire the events in 02 §3; render only allow-listed timers (02 §4) with their labels; enforce the E-SIGN channel rule and the party-scoping rule. Then implement the file's tests from 13 as Playwright and contract tests on the fixture calendar (13 §2). If a spec state is reachable but has no UI treatment in the file, add a `StatusCard` with a neutral copy key and list it under "Open UX items" in your report — do not design a new flow. Do not proceed to the next file until the stage's tests are green.

### 4.3 Review prompt (end of each stage)
> Diff the implemented card kinds, commands, events, timer codes, notice codes and roles against 01 §3, 02 §2–5 and the stage file. List anything implemented that is not named in the specs, anything named in the specs that is not implemented, and any copy string not present in 12. Fix or report.

## 5. Definition of done (package)

1. The three happy paths run end-to-end on the fixture calendar with sandbox counterparties, producing the evidence rows each spec requires (consents, `intent_records`, `disclosures.receipt_evidence`, `credit_authorizations`, `condition_clearances`, `signing_sessions`, `autodraft_enrollments`).
2. All 143 tests in 13 pass; serializer contract tests prove no internal fields leak.
3. Every string rendered is a key in 12; copy tests pass.
4. axe: no WCAG 2.2 AA violations on dark; light tokens switch without layout change.
5. `BACKEND-DELTAS.md` contains only DELTA-01…10 (or documented additions accepted by Doug).
6. The ops-console is untouched except where the specs already route human actions (`escalations`, `human_portal_task`); no borrower action can be performed by a human on the borrower's behalf.

## 6. Sequencing against the backend build

UX-0 and UX-1 can start against the origination Stage O-1 outputs (ULAD model, Timer Engine origination units, LE engine) with sandbox adapters. UX-2 needs Stage O-2 rails (DU, credit, verification, AMC, MI, flood, title, eClosing); UX-3 needs O-2 eClosing/eVault and O7.3 funding; UX-4 needs servicing Stage 1–2 (cashiering, escrow, notices, cases) and Stage 3 (default, loss mitigation); UX-5 needs O1 (rate-watch) and 16.x. Where a backend stage lags, the UI stage builds against recorded fixtures and the projection contracts in 02, so the screens exist when the first real event arrives.
