# 34.1 — Staff sign-in and roles: accounts, the doors, the action log, the access review

| Attribute | Value |
|---|---|
| Section | 34 — The operator portal: staff sign-in, the account directory, partner book operations and evidence |
| Automation class | c — a person signs in and acts; the platform records, refuses and reviews |
| Capacity | Platform operator (Supermortgage's own staff; internal only — no partner users) |
| Trigger & frequency | On every portal request; an invitation when an admin adds a staff member; the access review every 90 days |
| Governing source | GLBA Safeguards Rule 16 CFR §314.4(c)(1) and (c)(5) (access controls, multi-factor authentication for any individual accessing customer information); NYDFS 23 NYCRR §500.7 and §500.12 (access privileges reviewed periodically; MFA); 19.2 (security, access logging); 18.1 (AI governance: a human actor on every override); 32.2 and 32.14 (the door mechanics reused) |
| Key deadlines | A session idles out at 30 minutes; the access review every 90 calendar days |
| Timers | `SM_STAFF_ACCESS_REVIEW_90` |

### Blueprint row
The ops console at `/ops` takes the caller's word for who they are: two request headers name an actor id and a role, and every command on the bus runs under them. That was enough for a demo driven by the deploy workflow and not for a portal a team uses. This process gives staff real accounts: an admin invites a colleague by e-mail, the colleague signs in with a code to that e-mail and sets a password or a passkey, every request carries a session, every action lands on an action log with the person and the role, and an access review every quarter confirms who still needs what.

### Verified requirement (as of 2026-09-14)
**Access controls and MFA (16 CFR §314.4(c)(1), (c)(5); 23 NYCRR §500.7, §500.12).** Customer information may be accessed only by authorized users, with periodic review of privileges, and any individual accessing any information system must use multi-factor authentication unless the CISO approves equivalent controls in writing. A staff session here is a possession factor (a code to the e-mail, or a passkey) plus a knowledge factor (the password) — two factors; a code alone never opens a portal session. Privileges are the roles below, reviewed every 90 days (`SM_STAFF_ACCESS_REVIEW_90`, 19.2's own cadence) with the review recorded. **[VERIFIED — the Safeguards Rule text as amended 2021 (effective June 2023); 500.12(a) as amended November 2023.]**

**Every action is attributable (19.2; 18.1).** A command a person dispatches from the portal runs on the bus with `actor = {kind: human, id: <staff_user_id>, role}`; the decision record and the event carry it; the portal's own `staff_actions` row carries the request (route, subject, result) so a read-only view is logged too. Nothing in the portal bypasses a tool's guardrail: an `officer` waiver is an `officer` waiver because the session's role says so, never because a header did.

**Discrepancies vs blueprint**: (1) The header actor (`x-actor-id`, `x-actor-role`) is retired for browsers; it survives only for the deploy workflow's own smoke calls behind the ops bearer token, and only outside production. (2) No SSO in this process: an OIDC door for staff (the borrower side has one, 32.14 DELTA-12) is a later extension; the e-mail code plus password/passkey is the door today.

### Operational prerequisites
- The first admin: `main.ts staff-bootstrap <email>` (or the environment variable `STAFF_BOOTSTRAP_ADMIN_EMAIL` read once at start) creates the first `staff_users{roles=[admin]}` row and sends the invitation; nothing else creates an admin without an admin.
- The FAKE e-mail port in every build stage (the code and the invitation are visible as `fake_code` outside production, exactly as the borrower doors).
- Production: the portal host behind the identity-aware proxy the deploy guide names, in addition to this door.

### Build spec
#### Inputs and triggers
- `POST /ops/api/staff/invite` (admin) → `staff.invite`; `POST /ops/api/auth/code` `{email}` → a code by e-mail (FAKE outside production, `fake_code` echoed); `POST /ops/api/auth/verify` `{email, code}` → a short-lived enrol/step token (never a portal session); `POST /ops/api/auth/password` `{token, password}` (set at enrolment, or reset) and `POST /ops/api/auth/signin` `{email, password}` → `staff.signin` → a session; `POST /ops/api/auth/passkey/*` (register on an enrolled session; sign in with a passkey as the second factor in place of the code); `POST /ops/api/auth/signout`.
- Every `/ops/api/*` request → the session from the `sm_staff` cookie or `Authorization: Bearer` (30-minute idle, 12-hour absolute) → `staff_actions` row → the route.
- `PUT /ops/api/staff/{id}/roles` (admin) → `staff.role.set`; `POST /ops/api/staff/{id}/disable` (admin) → `staff.disable`; `POST /ops/api/staff/access-review` (compliance or admin) → `staff.access.review`.
- Events: `staff.invited{staff_user_id, invited_by, roles}`, `staff.enrolled{staff_user_id, factor ∈ password|passkey}`, `staff.signed_in{staff_user_id, session_id, factors}`, `staff.signed_out`, `staff.role.changed{staff_user_id, roles_before, roles_after, by}`, `staff.disabled{staff_user_id, by}`, `staff.access_review.completed{reviewed_by, users, changes}` (all global; none carries an e-mail).

#### Data model
New tables (append-only where noted; retention `security_logs_5y` for the log, `corporate_7y` for accounts):
- **`staff_users`** (new): `id uuid pk`, `email_hash text unique`, `email_encrypted bytea`, `legal_name text`, `roles text[]` (⊆ {ops_analyst, officer, compliance, admin}), `status text` ∈ {invited, active, disabled}, `invited_by uuid`, `invited_at`, `enrolled_at`, `disabled_at`, `created_at`.
- **`staff_credentials`** (new): `id uuid pk`, `staff_user_id` → `staff_users`, `kind text` ∈ {password, passkey}, `secret_hash text` (argon2id for a password; the credential public key and id for a passkey), `label text`, `created_at`, `revoked_at`.
- **`staff_sessions`** (new): `session_id uuid pk`, `staff_user_id`, `token_hash text`, `factors text[]`, `created_at`, `last_seen_at`, `expires_at`, `revoked_at`, `ip text`, `user_agent text`.
- **`staff_actions`** (new; append-only): `id uuid pk`, `staff_user_id`, `session_id`, `at timestamptz`, `route text`, `method text`, `subject_kind text`, `subject_id text`, `command text` (the bus command when one ran), `result text` ∈ {ok, refused, error}, `refusal_code text`, `created_at`.
- **`staff_access_reviews`** (new; append-only): `id uuid pk`, `reviewed_by uuid`, `reviewed_at`, `users jsonb` (each user's roles and the reviewer's decision keep|change|disable), `created_at`.
- Baseline tables written: `auth_challenges` (the e-mail code, reused from 32.2 with `subject_kind = staff`), `loan_events` (the events above), `agent_decisions` (`staff.role.set`, `staff.disable`, `staff.access.review` — human decisions with rationale), `timers` (`SM_STAFF_ACCESS_REVIEW_90`), `escalations` (a breached review).

#### State machine
Per staff user: `invited —(code verified + password or passkey set)→ active —(admin)→ disabled`; a disabled user's sessions are revoked in the same transaction and never reopen. Per session: `open —(30 minutes idle | 12 hours | sign-out | disable | role change)→ closed`. The access review: `due —(staff.access_review.completed)→ done` and re-armed 90 days out; a breach escalates to `compliance`.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `SM_STAFF_ACCESS_REVIEW_90` | recurring | `staff.access_review.completed` | `reviewed_at` | +90 calendar_days | `staff.access_review.completed` | sev 3 → `compliance` (the quarterly access review is late) |

Jurisdiction overrides: none.

#### Business rules and calculations
1. **Two factors, always.** A portal session opens only after a possession factor (the code to the e-mail on file, or a registered passkey) and the password; a code alone yields an enrol/step token good for 10 minutes that can set or reset the password and register a passkey, and nothing else. Passwords: at least 12 characters, checked against the breached-password list the borrower door uses, hashed with argon2id; five failed sign-ins lock the account for 15 minutes and log `staff.signin.locked`.
2. **Roles are the only authority.** `ops_analyst` reads everything the directory and the partner-book views show and dispatches ops commands (uploads, resolutions, escalation completion, outbox requeue); `officer` additionally approves what the sections' tools reserve to `officer` (campaign approvals, waivers on money fields); `compliance` reads everything including unmasked PII for a case, runs the access review and the evidence pack, and trips or resets the AI kill switch with `admin`; `admin` manages staff users and roles and nothing else that touches a borrower. A role is never self-granted: `staff.role.set` refuses the caller's own row (`NO_SELF_ROLE_CHANGE`) and always keeps at least one active `admin`.
3. **The actor on the bus is the session's.** `actorOf(request)` resolves the session and returns `{kind: human, id: staff_user_id, role}` for the route's chosen role when the user holds it; a route that needs a role the user lacks answers 403 `ROLE_REQUIRED{role}` before any read. The header actor is honoured only when the request carries the ops bearer token (the deploy workflow) and `ENVIRONMENT ≠ production`.
4. **Everything is logged, nothing sensitive is.** One `staff_actions` row per request, before the handler runs, completed with the result; the row carries subject ids, never a name, e-mail, phone or figure; the log is exportable in the evidence pack (34.4) and retained five years.
5. **Sessions end.** 30 minutes idle, 12 hours absolute, sign-out, a role change or a disable — each revokes and answers 401 `SESSION_EXPIRED` on the next request; the browser returns to the door with the return path kept.
6. **The access review.** Every 90 days `compliance` (or `admin`) confirms each active user's roles (keep, change, disable); the review is a `staff_access_reviews` row and a decision record; changes run through `staff.role.set`/`staff.disable` so they are logged like any other.

No money figure is computed here.

#### Integrations
- **`edelivery`** (the invitation and the code by e-mail; FAKE outside production with `fake_code` echoed).
- **`webauthn`** (the borrower side's passkey implementation reused: `src/runtime/borrower/webauthn.ts`).
- No vendor.

#### Outputs and artifacts
- Rows: `staff_users`, `staff_credentials`, `staff_sessions`, `staff_actions`, `staff_access_reviews`, `auth_challenges`, `agent_decisions`, `timers`.
- Events: `staff.invited`, `staff.enrolled`, `staff.signed_in`, `staff.signed_out`, `staff.role.changed`, `staff.disabled`, `staff.access_review.completed`, `staff.signin.locked`.
- Notice `NTC_SM_STAFF_INVITATION` (e-mail: the inviter's name, the roles, the sign-in address, "a code will be sent to this e-mail"; no borrower data).
- The portal's door: sign-in, code, password set/reset, passkey enrolment; the staff list and roles page (admin); the access review page (compliance).

#### AI agent design (AI-first)
`security-records` agent (tools: `staff.invite`, `staff.signin`, `staff.role.set`, `staff.disable`, `staff.access.review`). End-to-end: `staff.invite` writes the user and sends the invitation; `staff.signin` verifies the factors and opens the session (the only path to a session); `staff.role.set` and `staff.disable` are admin decisions with rationale; `staff.access.review` records the quarterly review and satisfies the clock. Decision record schema `{staff_user_id, action, roles_before, roles_after, rationale, by, rule_set_version: staff.access.v1, model_version: deterministic, prompt_version: 34.1-v1, confidence: 1}`. Guardrails: `TWO_FACTORS` (no session on one factor), `NO_SELF_ROLE_CHANGE`, `LAST_ADMIN_STAYS`, `NO_HEADER_ACTOR_IN_PRODUCTION`, `NO_PII_IN_LOG` (the action log carries ids only). Escalations: `compliance` on a late access review and on five failed sign-ins for one account in an hour; `admin` for nothing automatic.

#### Edge cases and failure modes
- The invitation e-mail bounces → `staff_users.status` stays `invited`, the admin sees the bounce on the staff page and can re-invite to a corrected address (the old e-mail hash is superseded, never reused).
- A user with no passkey loses e-mail access → an admin re-invites (a new code path); a password alone never opens a session.
- Two admins disable each other simultaneously → `LAST_ADMIN_STAYS` refuses the second.
- The ops bearer token leaks → it can only act as the FAKE header actor outside production; in production it opens nothing.
- The clock breaches because no one ran the review → one `compliance` escalation; the review page shows it overdue; sessions keep working (the control is the review, not a lock-out).

#### Test cases and acceptance criteria
| ID | Acceptance test |
|---|---|
| 34.1-T1 | Given the bootstrap admin, when they invite a colleague with roles `[ops_analyst]`, then a `staff_users{status=invited}` row exists with the e-mail hashed, `NTC_SM_STAFF_INVITATION` is sent to that e-mail (the FAKE port holds it, naming the inviter and the roles and no borrower data), `staff.invited` is logged without the e-mail, and the colleague's `POST /ops/api/auth/code` + `verify` yields an enrol token that opens no session (`GET /ops/api/me` with it answers 401). |
| 34.1-T2 | Given the enrol token, when the colleague sets a 12-character password and signs in with e-mail and password, then a session opens with `factors = [email_code, password]`, `GET /ops/api/me` answers their id and roles, `staff.enrolled` and `staff.signed_in` are logged; given an 11-character or breached password, then `PASSWORD_WEAK` and no credential row. |
| 34.1-T3 | Given a session, when the clock passes 30 minutes idle, then the next request answers 401 `SESSION_EXPIRED` and the row reads revoked; given five wrong passwords in a row, then the sixth attempt answers `ACCOUNT_LOCKED`, `staff.signin.locked` is logged and a `compliance` escalation exists. |
| 34.1-T4 | Given an `ops_analyst` session, when they call an officer-only route (a campaign approval) then 403 `ROLE_REQUIRED{officer}` before any write; given an `officer` session, then the same call runs on the bus with `actor = {human, <staff_user_id>, officer}` and the decision record names them; given a request with only the legacy `x-actor-*` headers and no bearer, then 401. |
| 34.1-T5 | Given an admin, when they change a colleague's roles, then `staff.role.changed{roles_before, roles_after, by}` is logged, the colleague's open sessions are revoked, and a decision record carries the rationale; when they try to change their own roles, then `NO_SELF_ROLE_CHANGE`; when they try to disable the last admin, then `LAST_ADMIN_STAYS`. |
| 34.1-T6 | Given every request of a session (reads and writes), then one `staff_actions` row per request exists with route, subject ids, command and result, and no row carries a name, an e-mail, a phone number or a money figure. |
| 34.1-T7 | Given a passkey registered on an enrolled session, when the user signs in with the passkey and the password, then a session opens with `factors = [passkey, password]` and no code was sent; given the passkey alone, then no session. |
| 34.1-T8 | Given the last access review 90 calendar days ago, when the sweep passes, then `SM_STAFF_ACCESS_REVIEW_90` reads `breached` with one `compliance` escalation; given `staff.access.review` recording keep/change/disable for every active user, then the changes are applied through `staff.role.set`/`staff.disable`, `staff.access_review.completed` is logged, the clock is satisfied and re-armed 90 days out. |

#### Audit and evidence
What an examiner is shown: the staff list with roles, enrolment dates and factors; the action log filtered by person, subject or date; the access reviews with each decision; the sign-in and lock events; the timer history of the review clock. Exported through the evidence pack (34.4).

### Open questions / decisions
1. Should staff sign-in also accept the organization's SSO? **Default: not in this process; the OIDC door is a later extension on the same session table.**
2. Should read-only requests be logged at full volume? **Default: yes — one row per request; the table is append-only and retained five years.**

### Sources
- 16 CFR §314.4(c)(1), (c)(5) (FTC Safeguards Rule, as amended); 23 NYCRR §500.7, §500.12 (NYDFS, as amended Nov 2023); spec/sections/19-*/19-2 (security and access logging); 32.2 §2 and 32.14 DELTA-14 (the door mechanics); src/runtime/borrower/auth.ts, webauthn.ts, borrower-credentials.ts (reused); src/console/server.ts (the header actor this retires).
