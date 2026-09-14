# 18 — Dual Mode: Autopilot and Workspace

**Package amendment · September 2026 · for Claude Code.** This file amends the borrower UX package (`docs/ux/00`–`17`). It is **not** imported as a 32.x process — process **32.18** is already the DU moment. Dual Mode is two realities on **one party account**, projected from the same `borrower_record`, `card_instances`, and commands the rest of the package already names. Nothing in sections 1–31 changes.

This pull request ships **W0 (this document and the principle amendments) + W1 (Workspace Home)** only.

## 0. Two realities, one party account

A signed-in party has one account (`party_id`). That account has two first-class surfaces:

1. **Autopilot** — the continuous refinance / servicing cycle is agentically driven. The platform initiates. The borrower is made **aware** of what is in motion and gives **occasional approvals** (cards). They do not have to live in the thread to stay current.
2. **Workspace** — a real login dashboard. The borrower digs into the mortgage, payment, application, and documents themselves. Shortcuts and an inbox of pending cards are the door; typing into chat is not required to find Pay, Statements, Documents, or the application.
3. **Guide (Michelle)** — the existing conversational agent, always available from Workspace (drawer or `/guide`). Guide is not the only door into the product. The thread, rail, action bar, and agent turn of docs/ux/17 stand, under Guide.

There is **one** borrower surface (`apps/borrower`, mounted at `/app`). Dual Mode is not a second portal, not an ops console, and not a partner site.

## 1. Binding principles (in addition to `00` §2)

1. **Cards still commit.** Nothing legally consequential — a consent, a disclosure receipt, a lock, an intent to proceed, a signature, an authorization, a payment, Offer Yes — exists only as chat text. Each has a typed card that produces the evidence row the build spec requires. Workspace buttons that look like Pay / Approve / Confirm expand or focus the existing `card_instances` row and resolve it through `resolveCard`. They do not invent a parallel commit path.
2. **Nothing invented.** No new domain table, timer code, notice, command, or role. UI-owned objects (`card_instances`, routes, projections over existing reads) are allowed, as `00` §2.7 already allows.
3. **Initiative belongs to the platform (Autopilot).** In servicing, system-initiated awareness must outnumber borrower-initiated hunting. Workspace Home's "What's happening" is that awareness, read from existing projections (`status.one_liner`, `what_we_are_doing[]`, `partner_book.review`), not a new event log in W1.
4. **Workspace is first-class.** Post-auth default landing is Workspace Home, not an empty thread. Unauthenticated traffic still goes to account / sign-in (`docs/ux/15`, `17` §2.0).
5. **Guide is always one control away.** The agent turn is not removed; it is repositioned. `/guide` is the conversation (thread + rail + action bar). A persistent Guide control on Workspace opens the same agent (drawer or that route).
6. **Loan glance is never buried.** When the party has a subject (`loan_id` and/or `application_id`), status, key Numbers, and autopay (when applicable) are visible on Home without opening a collapsed "Your record" section.
7. **Partner-book clarity.** For `loans.status = monitored`, the partner named on `partner_book` is the servicer of record and keeps servicing the loan. Supermortgage is watching for a refinance. Copy never names Supermortgage as the lender of that loan. Payment / autopay / escrow / hardship commands stay unavailable (`LOAN_MONITORED`).
8. **Fair lending / copy rules unchanged.** No invented rates. No "you don't qualify". Every borrower-facing sentence is a copy key (`docs/ux/12`).
9. **One account, both origination and servicing.** The header subject switcher is unchanged. Workspace Home follows the selected subject; Guide's thread remains per party.

## 2. Information architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Supermortgage     Home · Guide          [subject switcher]   Sign out   │
├──────────────────────────────────────────────────────────────────────────┤
│  WORKSPACE HOME (post-auth default, `/`)                                 │
│                                                                          │
│  Loan glance     badge · one-liner · Numbers · autopay (when applicable) │
│  Needs you       pending card_instances — tap expands, resolveCard       │
│  What's happening Autopilot digest (existing projections; W1 honest gap) │
│  Shortcuts       Pay · Statements · Documents · Application (relevant)   │
│                                                                          │
│  [ Guide ]  persistent — drawer with thread + action bar, or `/guide`    │
└──────────────────────────────────────────────────────────────────────────┘

`/guide` — Michelle: thread (left) + rail (right) + action bar. Unchanged 17 §2.
```

| Surface | Route | What it is | Reads | Commits |
|---|---|---|---|---|
| **Workspace Home** | `/` (authenticated) | Dashboard: glance, approvals inbox, happening, shortcuts | `borrower_record`, `card_instances{status=pending}` | none except via cards |
| **Approvals inbox** | section of Home (W3 may split) | Needed-from-you + other pending cards that belong under Needed | `needed_from_you[]` + pending `card_instances` | `resolveCard` only |
| **Guide** | `/guide`, or a drawer from Home | The conversation (docs/ux/17) | `thread_messages`, pending cards, `borrower_record` | `resolveCard`; words never commit consents/payments/Offer Yes |
| **Account** | `/sign-up`, `/sign-in`, `/reset` | Unchanged (`17` §2.0) | credentials | session |

Unauthenticated `/` and `/guide` render the sign-in form (`auth.welcome_back`), same as today.

## 3. Autopilot — awareness and approval

Autopilot is not a separate product. It is the platform's initiative expressed on Workspace:

- **Awareness.** Home's "What's happening" restates what the record already knows: the status one-liner, `what_we_are_doing[]` (conditions we or a third party own), and — on a monitored loan — `partner_book.review` copy keys (`refi.review.*`). W1 does **not** add an activity-feed table. If those projections are empty, the section is an honest empty (`workspace.happening.empty`) rather than invented motion. A richer digest (W4) is a later projection over existing events; see BACKEND-DELTAS DELTA-32.
- **Approval.** Anything that needs the borrower is a pending card in Approvals. Tapping it expands the existing card component. Confirm / Pay now / Connect still call `resolveCard`. Chat must not silently commit.

Rate-watch offers, lock, intent, consents, and payments continue to arrive as the cards the owning flows already send. Workspace surfaces them; it does not originate them.

## 4. Workspace sections → existing reads and commands

| Home block | Projection / objects | Commands (existing) | Notes |
|---|---|---|---|
| Loan glance | `borrower_record.status`, `.numbers` (pre- or post-funding), `.loan.autodraft` | none (read-only) | Servicing: balance, rate, next payment, due, autopay on/off. Pre-funding: rate / payment / amount / lock as the figures_source allows. Partner-book facts may omit a next-payment amount — show what is present, invent nothing. |
| Status line (monitored) | `partner_book.monitored`, `status.one_liner` = `partner_book.monitored`, token `servicer` | none | "{servicer} still services this loan. Supermortgage is watching for a refinance." Never "Supermortgage is your servicer." |
| Approvals | `needed_from_you[]`, `card_instances{status=pending}` (Needed kinds; same `neededRows` rule as the rail) | `resolveCard` → mapped 32.2 command | Same components as the rail. `?card=` expands that row. |
| What's happening | `status.one_liner`, `what_we_are_doing[]`, `partner_book.review.{outcome,reasons_copy_keys}` | none | W1; richer Autopilot digest is DELTA-32 / W4. |
| Shortcut Pay | pending `PaymentCard`, or post-funding numbers when a payment card can be requested | `resolveCard` on that card; **not** a new command. Hidden when `partner_book.monitored` (commands_unavailable includes payment.*) | Does not type into Guide. W2 is the full payments tree. |
| Shortcut Statements / Documents | `borrower_record.documents[]` (+ DocumentCard / NoticeCard) | `disclosure.acknowledgeReceipt` etc. via the card | W1 lists documents from the record; W2 is the statements section tree. |
| Shortcut Application | `subject.application_id`, `journey_progress`, needed origination cards | via those cards | Hidden when there is no application subject. |
| Guide | `thread_messages`, agent turn (`17` DELTA-23) | `borrowerMessage`; cards via `resolveCard` | Drawer or `/guide`. |
| Subject switcher | `me.subjects[]` | none; re-fetch `borrower_record` for the selection | Unchanged behavior, including reload on change. |

Preferences (contact permissions, e-delivery, language, autopay) remain cards the borrower can request and that the platform offers when relevant. There is still **no settings tree**. A later Workspace settings screen (W7) may group those cards; it is backed by the same commands.

## 5. Amendments to “no dashboard”

`01` §1.5 previously said: "No dashboard, no settings tree." That sentence is amended:

- **Workspace Home is a dashboard** — a projection of `borrower_record` and pending `card_instances`, not a hand-authored page and not a second system.
- **No settings tree** still holds in W0–W1. Preferences stay cards (or, later, Workspace settings that raise the same cards).
- **The rail is still the Record** under Guide. On Workspace Home the glance is the Numbers that used to sit behind a default-collapsed "Your record" section; Home must not reuse that collapsed section as the only place Numbers live.
- **The thread is no longer the only navigation.** Shortcuts, Approvals, and the glance are doors. Guide remains the conversation.

`00` §2.5 ("The Record is a projection, not a page") stands. Workspace Home is another projection of the same record, not a competing source of truth.

`17` ("an account, then a conversation") is amended: an account, then **Workspace Home**, with **Guide** (the conversation) always available. The first turn of a new session still runs; it is not the first thing the eyes land on.

## 6. Non-goals (this PR and Dual Mode generally)

- **No second borrower portal.** Ops console, partner-facing surfaces, and §34 are out of scope.
- **No invented domain tables, timer codes, notices, or commands.**
- **Cards still commit**; chat does not silently commit consents, payments, or Offer Yes.
- **No full Payments / Statements / Escrow section trees** — that is **W2**.
- **No full Activity feed** — that is **W4**.
- **No 33.3 readiness checklist UI** — readiness remains on `borrower_record` for the Guide turn; Home does not build a second interview from it.
- **No replacement of Michelle.** Guide is the same agent turn.
- **INTEGRATIONS=fake** in every build stage; this PR does not require live vendors.

## 7. Build phases

| Phase | What | This PR? |
|---|---|---|
| **W0** | This document; amend `00`, `01` §1.5, `17`; BACKEND-DELTAS; copy keys | **Yes** |
| **W1** | Workspace Home: post-auth landing, loan glance, Approvals → `resolveCard`, happening from existing projections, shortcuts, Guide entry, subject switcher, monitored Status line | **Yes** |
| **W2** | Payments / Statements / Documents section trees (08a), still cards-commit | No |
| **W3** | Approvals as a dedicated inbox route if Home outgrows the list | No |
| **W4** | Activity / Autopilot digest as a projection over existing events (DELTA-32) | No |
| **W5** | Application workspace (origination journey as a readable board, still rail cards) | No |
| **W6** | Servicing deep-dives (escrow, insurance, hardship) as Workspace routes that raise existing cards | No |
| **W7** | Workspace settings grouped from existing preference / consent cards; still no invented preference store | No |

## 8. Copy keys (authored in `12`)

`workspace.*` chrome (title, glance labels, approvals, happening, shortcuts, Guide, nav) and `partner_book.monitored` (status one-liner for `loans.status = monitored`; token `{{servicer}}`).

## 9. Tests this phase owes

- Authenticated `/` renders Workspace Home (`data-testid="workspace-home"`), not the empty thread as the first surface.
- Unauthenticated `/` is still account / sign-in.
- When a subject exists, the glance shows the badge and Numbers (not behind a collapsed Record section).
- Pending cards listed under Approvals expand in place and resolve through `resolveCard` (same `data-rail-card` contract so `?card=` and vendor return keep working).
- Guide is reachable from Home (drawer and/or `/guide`).
- Pay is hidden on a monitored loan; the partner Status line uses `partner_book.monitored`.
- Conversation / rail e2e that assumed `/app` was the thread move to `/app/guide`.
