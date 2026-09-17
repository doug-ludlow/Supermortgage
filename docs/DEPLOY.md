# Deploying Supermortgage to Google Cloud (nonprod)

This is the owner's runbook. It assumes you have never used Google Cloud. Follow
the steps in order; each one tells you exactly what to click or paste.

What you end up with, in one Google Cloud project (every row is a resource in `infra/terraform/`):

| Piece | What it is |
|---|---|
| Cloud Run service `supermortgage-api` | the HTTP server (`serve` mode: the API and the ops console), `min_instances` 1 to `max_instances` 10 by default (`variables.tf`), ingress from the load balancer only (`run.tf`) |
| Cloud Run service `supermortgage-borrower` | the borrower app (`apps/borrower`, Next.js standalone from `Dockerfile.borrower`, basePath `/app`), `borrower_min_instances` 1 to `borrower_max_instances` 10 by default; built with three build args — `NEXT_PUBLIC_ENVIRONMENT=<environment>` (a nonprod bundle shows the FAKE vendor paths the `INTEGRATIONS=fake` API expects, Google sign-in included), `NEXT_PUBLIC_PARTNER_LEGAL_NAME` and `NEXT_PUBLIC_PARTNER_NMLSR_ID` (the disclosure footer's partner before a session exists) — served at `https://demo.supermortgage.com/app` by the `/app`, `/app/*` URL-map rule to its own serverless NEG and backend |
| Cloud Run service `supermortgage-partner` | the servicing partner portal (section 36: `apps/partner`, Next.js standalone from `Dockerfile.partner`, basePath `/partners`), `partner_min_instances` 1 to `partner_max_instances` 10 by default; built with the borrower image's three build args (`NEXT_PUBLIC_ENVIRONMENT=<environment>`, `NEXT_PUBLIC_PARTNER_LEGAL_NAME` and `NEXT_PUBLIC_PARTNER_NMLSR_ID` — the partner named on the sign-in door before a session exists); its server-side cookie proxy forwards only `/v1/partner/*` to the API with the partner session as the bearer and holds no API token — served at `https://demo.supermortgage.com/partners` by the `/partners`, `/partners/*` URL-map rule to its own serverless NEG and backend ("The partner portal" below) |
| Cloud Run job `supermortgage-migrate` | applies `db/migrations/*.sql` (`migrate` mode); run before every deploy |
| Cloud Run job `supermortgage-sweep` | one sweep minute (`sweep` mode): the borrower flows' scheduled tick, then `Runtime.sweep()` — the outbox drain, the cycles pass, the daily refinance check, the partner-book passes, the FAKE reviewers, the roles / work / posture / orchestration passes, the record verify, the breach pass and the rest, in the order "The sweep" below lists |
| Cloud Run job `supermortgage-seed-demo` | boards the 100-loan demo transfer batch, the entry demo and the partner book (`seed-demo` mode, idempotent); run on demand |
| Cloud Scheduler `supermortgage-sweep-every-minute` | starts the sweep job on `* * * * *` in `America/New_York` with a 180 s attempt deadline (`scheduler.tf`) |
| Cloud SQL (PostgreSQL 16) `supermortgage-nonprod` | the database, encrypted with a customer-managed key (KMS key ring `supermortgage-nonprod`, key `supermortgage-sql`, `kms.tf`), `ssl_mode = "ENCRYPTED_ONLY"`, a public IP with no authorized networks (only the Cloud Run socket path reaches it, `sql.tf`), daily backups + point-in-time recovery |
| Secret Manager | `supermortgage-database-url` and `supermortgage-api-token` (written by Terraform), plus five secrets Terraform creates with the placeholder first version `unset` for you to replace by hand: `supermortgage-anthropic-api-key`, `supermortgage-tavus-api-key`, `supermortgage-video-callback-secret`, `supermortgage-google-oauth-client-id`, `supermortgage-google-oauth-client-secret` (`secrets.tf`) |
| Artifact Registry `supermortgage` | the `api`, `borrower` and `partner` container images built by GitHub Actions |
| Global HTTPS load balancer + Cloud Armor | `demo.supermortgage.com` (the API, the console, the borrower app and the partner portal on one name), a Google-managed certificate; Cloud Armor with the preconfigured SQLi / XSS WAF rules in `preview = true` (logged, not enforced) and an enforced rate limit of 1200 requests per 60 s per source IP; the URL map sends `/` → 302 `/app`, `/video` and `/video/*` → 302 `/app/video`, `/app` and `/app/*` to the borrower backend, `/partners` and `/partners/*` to the partner backend and everything else to the API backend (`lb.tf`) |
| Four service accounts | `runtime` (the API service and the three jobs), `borrower` (the borrower app; reads only the API token secret), `partner` (the partner portal; writes logs and metrics, reads no secret) and `scheduler` (holds `run.invoker` on the sweep job alone) — `iam.tf` |

Everything is created by Terraform (`infra/terraform/`) from a GitHub Actions
workflow (`.github/workflows/deploy.yml`). The only thing you run by hand is a
one-time bootstrap script.

---

## 1. Create a Google Cloud project and attach billing

1. Open <https://console.cloud.google.com/projectcreate>. Sign in with the
   Google account that should own the environment.
2. **Project name**: `Supermortgage nonprod`. Click **Edit** next to the
   generated project ID and set it to `supermortgage-nonprod` (project IDs are
   global; if that one is taken, use e.g. `supermortgage-nonprod-1`). Write the
   final ID down: it is `PROJECT_ID` everywhere below.
3. Click **Create** and wait for the notification.
4. Attach billing: open
   <https://console.cloud.google.com/billing/linkedaccount> with the new
   project selected in the top bar, click **Link a billing account**, and pick
   (or create) one. Nothing below can be created until this is done.

Rough nonprod cost with the defaults: Cloud SQL `db-custom-1-3840` zonal
(about $50/month), three always-on Cloud Run instances — the API service (about
$30/month, CPU always allocated), the borrower app's minimum instance and the
partner portal's (`cpu_idle = true`, 512Mi each) — the load balancer forwarding
rules (about $18/month), plus cents for the rest.

## 2. Run the bootstrap script in Cloud Shell

Cloud Shell is a terminal in your browser that is already logged in as you.

1. Open <https://shell.cloud.google.com> (or click the `>_` icon at the top
   right of the Cloud Console). Wait for the prompt.
2. Paste this, replacing the project ID if yours differs, and press Enter:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/doug-ludlow/Supermortgage/claude/mortgage-subservicer-builder-y9nr7e/infra/bootstrap.sh \
     | PROJECT_ID=supermortgage-nonprod bash
   ```

   Alternative, if you prefer to see the script first:

   ```sh
   git clone -b claude/mortgage-subservicer-builder-y9nr7e https://github.com/doug-ludlow/Supermortgage.git
   cd Supermortgage
   PROJECT_ID=supermortgage-nonprod bash infra/bootstrap.sh
   ```

   Optional inputs: `REGION` (default `us-central1`), `GITHUB_REPO` (default
   `doug-ludlow/Supermortgage`), `TF_STATE_BUCKET` (default
   `<PROJECT_ID>-supermortgage-tfstate`).

3. The first time, Cloud Shell asks you to **Authorize** gcloud; click it.
4. The script takes one to two minutes. It is safe to run again if it stops
   part-way (every step checks whether its resource already exists).

What it did: enabled the Google APIs, created the Terraform state bucket,
created the `supermortgage-deployer` service account, and set up Workload
Identity Federation so GitHub Actions can act as that service account with no
downloaded key file.

## 3. Set the GitHub repository variables (and the two optional secrets)

The script ends with a block like this:

```
   Name               Value
   -----------------  ------------------------------------------------------------
   GCP_PROJECT_ID     supermortgage-nonprod
   GCP_REGION         us-central1
   GCP_WIF_PROVIDER   projects/123456789012/locations/global/workloadIdentityPools/github/providers/github
   GCP_DEPLOYER_SA    supermortgage-deployer@supermortgage-nonprod.iam.gserviceaccount.com
   TF_STATE_BUCKET    supermortgage-nonprod-supermortgage-tfstate
```

Open <https://github.com/doug-ludlow/Supermortgage/settings/variables/actions>,
click **New repository variable**, and add each of the five, name and value
exactly as printed. These are *Variables*, not *Secrets*: none of them is
sensitive, and authentication to Google Cloud is Workload Identity Federation,
so no cloud key is stored in GitHub.

Two more repository variables are optional; the borrower image's build reads
them and falls back to the demo partner when they are unset
(`deploy.yml` "docker build (borrower)"; `Dockerfile.borrower`):

| Variable | Build arg | Default when unset |
|---|---|---|
| `PARTNER_LEGAL_NAME` | `NEXT_PUBLIC_PARTNER_LEGAL_NAME` | `Partner Bank` |
| `PARTNER_NMLSR_ID` | `NEXT_PUBLIC_PARTNER_NMLSR_ID` | `123456` |

The partner image's build (`deploy.yml` "docker build (partner)"; `Dockerfile.partner`)
reads the same two variables for the partner named on the portal's sign-in door before
a session exists; no variable is added for it. The walk job passes the same values to
the partner walk (`WALK_DOOR_PARTNER_LEGAL_NAME`, `WALK_DOOR_PARTNER_NMLSR_ID`) so it
asserts the door the image was built with.

Two repository **secrets** (Settings → Secrets → Actions) are read by the
pipelines, both optional and both missing until you add them:

- `POSTURE_PRINCIPAL_TOKEN` — a 35.7 service-principal token, issued once with
  `principals.issue`. The deploy job's "Record the environment manifest" step
  posts the environment manifest under it; without the secret the step prints
  a notice and skips (§4).
- `WALK_OPS_TOKEN` — the value of
  `gcloud secrets versions access latest --secret supermortgage-api-token`, read
  only by the on-demand `walk.yml` workflow (§4 "The demo walk"). The deploy
  workflow's own walk job reads the token out of Secret Manager and does not
  need this secret.

## 4. Run the deploy workflow

Either push a commit to `main` or to
`claude/mortgage-subservicer-builder-y9nr7e`, or run it by hand:

1. Open <https://github.com/doug-ludlow/Supermortgage/actions/workflows/deploy.yml>.
2. Click **Run workflow**, leave `environment` as `nonprod`, click the green
   **Run workflow** button.

**A docs-only push ships nothing.** The `push` trigger's `paths` filter
(`deploy.yml`) excludes `**/*.md` and `docs/**`, so a push that changes only
Markdown or `docs/` runs no build, no deploy and no walk. Two exceptions are
re-included because the image carries them: `spec/sections/**/*.md` (the agent
turn hands the model the current step's rules) and
`docs/ux/12-message-copy-library.md` (the runtime renders SMS, voice and talk
copy from it). `workflow_dispatch` always deploys.

The job graph (`deploy.yml` header: preflight -> terraform -> build (api +
borrower + partner, in parallel) -> migrate -> deploy):

1. `preflight` — checks the five variables; when one is missing the run stops
   here quietly instead of failing.
2. `terraform` — creates or updates everything in Google Cloud (the first run
   takes 15-25 minutes, mostly Cloud SQL) and collects the outputs the later
   jobs read (the artifact repo, the load balancer IP, the hostnames, the DNS
   records, the API token's secret name).
3. `build image`, `build borrower image` and `build partner image` — run in
   parallel, each needing only `terraform`. Each pushes an image tagged with
   the commit SHA and with the branch slug to Artifact Registry.
4. `migrate database` — needs `terraform` and `build`: points the
   `supermortgage-migrate` job at the new API image and executes it with
   `--wait`.
5. `deploy` — needs `terraform`, `build`, `build-borrower`, `build-partner`
   and `migrate`: points the sweep and seed-demo jobs at the new API image,
   deploys `supermortgage-api`, `supermortgage-borrower` and
   `supermortgage-partner`, then runs the steps below.
6. `demo walk` — needs `terraform` and `deploy`; described in "The demo walk".

Inside `deploy`, after the three services are deployed:

- **Record the environment manifest (35.12 posture.record)** —
  `continue-on-error`. With `POSTURE_PRINCIPAL_TOKEN` set, the step gathers an
  environment manifest of facts (the image digest, the migration head from the
  checkout, Cloud SQL's IP / PITR / CMEK settings, the service's env names and
  ingress, each `supermortgage-*` secret's name and latest-version creation
  time — never a payload — and the demo clock's status code) and posts it to
  `POST /v1/posture/manifests` under that token; `posture.record` hashes it,
  runs the posture check and opens drift findings. Without the secret the step
  prints a notice and exits 0. A failure never fails the deploy.
- **Four smoke steps**, each `continue-on-error`, each pinning the hostname to
  the load balancer IP with `--resolve` so they work before DNS propagates but
  with TLS fully verified, so they pass only once the DNS record exists and the
  managed certificate has provisioned:
  1. `/healthz` → 200;
  2. `/app` (the borrower app) → 200;
  3. `/` → 302, `/video` → 302, `/ops` → 200 (the staff sign-in page is public
     by design, 34.1 rule 1) and `/ops/api/me` → 401 without a staff session;
  4. `/partners` → 200 and `/partners/sign-in` → 200 (the portal's shell and its
     door; unauthenticated, the shell sends the browser to the door from the page,
     never a 3xx from the server) and `/partners/api/v1/partner/me` → 401 (the
     cookie proxy reached the API through the load balancer with no session).
- **Board the demo transfer batch** — only on a `workflow_dispatch` with
  `seed_demo` ticked (executes `supermortgage-seed-demo` with `--wait`).
- **Job summary** — prints the images, the Cloud SQL connection name, the load
  balancer IP and the DNS record for the next step.

The `deploy` job's **Summary** (click the run, then the summary at the top)
prints the load balancer IP and the DNS record for the next step. The four
smoke steps are expected to show a warning on the first run: they cannot pass
until DNS and the certificate are in place.

### The demo walk

After every deploy the `walk` job (`deploy.yml`; `timeout-minutes: 30`) drives
the Apply product on the deployed demo in a real Chromium browser:
`node --experimental-strip-types tests/walk/demo-walk.mts` from `apps/borrower`,
with `DEMO_BASE` set to the deployed hostname. It creates fresh accounts through
the door and checks the ten things a person must see work
(`apps/borrower/tests/walk/demo-walk.mts`):

1. A fresh window reaches the light door: welcome on the paper, none of the old
   shell, the disclosure footer; Continue → intro; "Create an account" → the
   account form with Google; "Already have an account?" → the sign-in form.
2. Creating an account lands on Apply at the goal step; `GET /me` through the
   page's proxy lists the application; no error line.
3. Buy with an address reaches the DU moment from the screens: goal → property
   → you → connect → details → the declarations → the demographics → "Confirm
   these numbers", with the DU-side facts read through the ops API.
4. Buy, still looking, ends at the preapproval request.
5. Refinance, cash out: `transaction_type` cash_out on the ops record, value,
   balance, cash out and its purpose collected, the same DU verdict.
6. Errors stay on the step, in copy.
7. My Loan is empty for a fresh account; Tasks marks the done rows and a tap
   jumps to the step.
8. Sign out works: the next load is the door; a second fresh context sees
   nothing of the first person.
9. A partner-book homeowner (33.1) signs in by code and lands on My Loan.
10. Returns and `?card=` land on the card.

Outcomes 3–5 read the application's record through the ops API
(`GET /v1/applications/{id}` with the API token), so the job authenticates to
Google Cloud the way the deploy job does, reads the token out of Secret Manager
(`api_token_secret` from the terraform outputs) into `WALK_OPS_TOKEN` and masks
it; without the token those outcomes fail by name
("WALK_OPS_TOKEN not provided …"), never pass. Outcome 9 needs the partner book
a `seed_demo=true` dispatch imports; an unseeded book fails, never passes. Every
step leaves a screenshot and the verdicts land in `report.json`; both are kept
as the run artifact `demo-walk` for 14 days, and the job summary lists
`<passed> of 10 outcomes hold on <base>` with one line per outcome. A failed
outcome fails the walk job, never the `deploy` job that preceded it. The walk
takes about two and a half minutes (deploy run 189 on 2026-09-16 read 10 of 10
in 2 min 28 s).

After the borrower walk, whatever it read, the same job walks the partner portal
(`node --experimental-strip-types tests/walk/partner-walk.mts` from `apps/partner`,
the same `DEMO_BASE`; "The partner portal" below lists its seven outcomes). Its
screenshots and `report.json` are the run artifact `partner-walk` (14 days), its
own `walk-out` beside the borrower's, and the job summary adds a "Partner walk"
block in the same form. The seeded `partner_admin` it signs in as comes from the
same `seed_demo=true` dispatch as the partner book; unseeded, outcome 2 fails by
name ("the seeded partner_admin is absent: dispatch seed_demo") and the outcomes
after it cannot pass. The log dump on failure covers both walks.

The same borrower walk runs on demand from
<https://github.com/doug-ludlow/Supermortgage/actions/workflows/walk.yml>
(`.github/workflows/walk.yml`; `timeout-minutes: 25`): **Run workflow** with
any base URL (default `https://demo.supermortgage.com`). That workflow does not
authenticate to Google Cloud; it takes `WALK_OPS_TOKEN` from the repository
secret of that name (§3), and without it outcomes 3–5 are NOT ok by name.

## 5. Point DNS at the load balancer (GoDaddy)

Only one hostname moves to Google Cloud: `demo.supermortgage.com`
(`api_hostname` and `console_hostname` both default to it in
`infra/terraform/variables.tf`, and the record list is `distinct()` over the
two, so Terraform emits one A record). The apex `supermortgage.com`, `www`,
email and anything else on the domain stay exactly where they are.

1. Log in at <https://dcc.godaddy.com/manage/> (My Products), find
   **supermortgage.com** and click **DNS** (on the cPanel-hosted product page it
   is **Domain -> Manage DNS**).
2. Click **Add New Record** and enter, using the IP from the workflow
   summary (or `terraform output load_balancer_ip`):

   | Type | Name | Value | TTL |
   |---|---|---|---|
   | A | `demo` | `<load balancer IP>` | 600 seconds |

   If a `demo` record already exists, edit it instead of adding a duplicate.
3. Wait. DNS propagates in a few minutes; the Google-managed certificate then
   provisions itself, which takes anywhere from 10 to 60 minutes. The
   certificate's name is `supermortgage-cert-<8 hex characters>` (a hash of the
   hostnames, `infra/terraform/lb.tf`; a hostname change creates a new
   certificate under a new name), so list it rather than guessing the name:

   ```sh
   gcloud compute ssl-certificates list --project supermortgage-nonprod
   gcloud compute ssl-certificates describe <name from the list> \
     --project supermortgage-nonprod --format 'value(managed.status,managed.domainStatus)'
   ```

   You want `ACTIVE` and the domain `ACTIVE`. `PROVISIONING` means keep
   waiting; `FAILED_NOT_VISIBLE` means the DNS record is not pointing at the
   load balancer yet.

## 6. Verify

From any machine:

```sh
curl -i https://demo.supermortgage.com/healthz     # HTTP/2 200
curl -i https://demo.supermortgage.com/readyz      # 200 once Postgres answers
curl -i https://demo.supermortgage.com/             # 302 → /app, the Apply product (32.19)
curl -i https://demo.supermortgage.com/ops         # 200: the staff sign-in page (34.1 rule 1)
curl -i https://demo.supermortgage.com/ops/api/me  # 401 AUTH_REQUIRED without a staff session
curl -i https://demo.supermortgage.com/partners     # 200: the partner portal's shell (the door follows, from the page)
curl -i https://demo.supermortgage.com/partners/api/v1/partner/me  # 401 without a partner session (the cookie proxy, through to the API)
```

Read the API token (generated by Terraform and stored in Secret Manager) in
Cloud Shell:

```sh
gcloud secrets versions access latest --secret supermortgage-api-token --project supermortgage-nonprod
```

and use it on the API routes (`/v1/*`, the route list is the comment block at
the top of `src/runtime/server.ts`):

```sh
TOKEN="$(gcloud secrets versions access latest --secret supermortgage-api-token --project supermortgage-nonprod)"
curl -H "Authorization: Bearer ${TOKEN}" https://demo.supermortgage.com/v1/tools
```

The console is at <https://demo.supermortgage.com/ops> (the root of the host
answers 302 → `/app`, the Apply product) and is gated by a staff session: every
`/ops/api/*` request resolves the session from the `sm_staff` cookie or an
`Authorization: Bearer <session token>` (`src/console/server.ts`, 34.1 rule 3).
The shared ops bearer token opens the console only together with the
`x-actor-id` / `x-actor-role` headers, and only outside production — that path
exists for the deploy workflow's own calls (`src/runtime/server.ts` route
comment); in production the headers open nothing (403
`NO_HEADER_ACTOR_IN_PRODUCTION`).

**The first operator-portal account (34.1 operational prerequisites).** `serve` reads `STAFF_BOOTSTRAP_ADMIN_EMAIL`
(Terraform `staff_bootstrap_admin_email`, `infra/terraform/run.tf`) once at start and, while `staff_users` is empty, creates
that account and sends `NTC_SM_STAFF_INVITATION` (the code is echoed on the sign-in page under `INTEGRATIONS=fake`); the
same runs as `main.ts staff-bootstrap <email>`. Its roles come from `STAFF_BOOTSTRAP_ADMIN_ROLES` (`staff_bootstrap_admin_roles`,
a comma list of `ops_analyst, officer, compliance, admin`; default on nonprod: all four), honoured **only when `ENVIRONMENT`
is not `production`** — in production the row holds `admin` only whatever the setting says, the log line
`staff-bootstrap: STAFF_BOOTSTRAP_ADMIN_ROLES ignored in production` says so, and the other roles are granted by a second
admin's `staff.role.set` with a rationale from the Staff page. Nonprod only, once: when the table holds exactly the bootstrap
row (invited by nobody) with a strict subset of the setting, the next start upgrades it through the real `staff.role.set`
path (rationale `bootstrap roles (nonprod)`; `staff.role.changed` and a decision record are written; the row's sessions are
revoked, so sign in again). A running nonprod that already has other staff rows gets the roles by re-creation — a fresh
database, `db/migrate.sh`, `seed-demo`, then the bootstrap — never by a hand-written `DELETE` across the staff tables
(`staff_actions` is the append-only five-year security log).

Useful commands:

```sh
# logs from the API service (last 30 minutes)
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="supermortgage-api"' \
  --project supermortgage-nonprod --freshness 30m --limit 100 --format 'value(timestamp,textPayload,jsonPayload.msg)'

# is the sweep running every minute?
gcloud run jobs executions list --job supermortgage-sweep --region us-central1 --project supermortgage-nonprod --limit 5

# database console (Cloud SQL Studio) — or connect with the Cloud SQL Auth Proxy
gcloud sql connect supermortgage-nonprod --user sm --database supermortgage --project supermortgage-nonprod
```

## Loading the demo portfolio

The console is empty until loans are boarded. The repo carries a 100-loan synthetic
servicing-transfer batch (`fixtures/transfer-batch-demo/`, September 1, 2026 transfer date)
that the runtime can board end to end through the 1.1 data-quality gate: 94 loans board,
6 stop as exceptions with an escalation each, and every timer boarding arms is live for the
sweep. Three ways to run it, all idempotent (a second run changes nothing):

- Actions → deploy → Run workflow → tick **seed_demo**.
- Cloud Shell: `gcloud run jobs execute supermortgage-seed-demo --region us-central1 --project supermortgage-nonprod --wait`
- The API: `curl -X POST -H "Authorization: Bearer $TOKEN" https://demo.supermortgage.com/v1/transfers/batches/demo`
- The entry experience (32.14) needs open states, the partner's NMLSR ID (read from the seeded `partners/<id>` row unless `BORROWER_DEFAULT_PARTNER_NMLSR_ID` overrides it) and an active rate sheet, or every visitor at the root hits the state gate: the seed-demo job seeds them after the batch (FAKE rows, idempotent), and `curl -X POST -H "Authorization: Bearer $TOKEN" https://demo.supermortgage.com/v1/entry/seed-demo -d '{"states":["AZ","CA","CO","UT","TX","FL","WA","NV"]}'` re-seeds them on demand (src/runtime/entry-seed.ts). New York is left closed on purpose (the closed-state path).

Your own batch goes to `POST /v1/transfers/batches` with `{ actor, batch, files }`, where
`files` carries the tape CSV texts in the layout documented in
`fixtures/transfer-batch-demo/LAYOUT.md`; `GET /v1/transfers/batches/<batch_id>` returns the
scorecard afterwards.

## The sweep

One sweep minute is what the `supermortgage-sweep` job runs each minute and what `POST /v1/sweep` runs on the
service (`src/runtime/main.ts` `sweep` mode): the borrower flows' scheduled `tick` first — every 32.x flow's scheduled
pass (`originationDailySweep`, `servicingDailySweep`, `delinquencyDailySweep`, the card expiries) — then
`Runtime.sweep()`, then the flows `settle` the reactions the sweep's commits queued. The flows' tick belongs to the
entry point (and to the demo clock's step, below), not to `Runtime.sweep` itself.

`Runtime.sweep()` (`src/runtime/app.ts`) first takes the sweep lease (`acquireSweepLease`, the advisory lock
`35_001`) and writes one `sweep_runs` row per firing whose `outcome` is `running`, then `completed`, `skipped` or
`failed`. A firing that finds the lease held writes the row as `skipped{lease_held}`, appends `sweep.run_skipped`
and exits 0 (35.1 rule 12); a lease that cannot be taken at all is `failed{lease_unavailable}`. Holding the lease,
it runs these passes in this order, each heartbeating the lease and timed into the row's `passes` (a pass marked
"logged" logs its failure and carries on; the others fail the run):

1. `outbox.dispatch` — the integration outbox drained (35.1 rule 11; its failure is the run's);
2. `cycles` — 35.3's `cycles.plan` under its planner lock and the executor running every claimable unit until the
   queue is empty or the 240 s budget is spent (logged);
3. `refi.daily` — the daily refinance check (`src/runtime/refi-daily.ts`, below; logged);
4. `partner_book.review` (33.2), 5. `partner_book.readiness` (33.3), 6. `partner_book.daily_reports` (34.3) — logged;
7. `controls` — 34.4: unconfirmed kill-switch requests expired at 10 minutes, a switch tripped over 24 hours escalated (logged);
8. `fake_reviewers` — the FAKE reviewers' tick (DELTA-30; only when wired; logged);
9. `roles.sweep` (35.7), 10. `work.sweep` (35.8), 11. `posture.sweep` (35.12), 12. `orchestration.pass` (35.6),
   13. `orchestration.daily_receipt` (once per platform day at/after 06:00 ET), 14. `refinance.closeout` and
   15. `refinance.board` (35.10) — logged;
16. `record.verify` — once per calendar day at/after `VERIFY_AT_ET` (06:00 America/New_York): the gaps, the
    mismatches and their escalations, one `projection_runs` row, `projection.run_completed`;
17. `default_case.daily` — 35.9's day, once per calendar day (logged);
18. `ops.steward` (35.11) and 19. `breach_action.recon` (35.9 rule 7) — logged;
20. `timers.breach` — the breach pass: the due timer instances claimed `FOR UPDATE SKIP LOCKED` in pages of 500, one
    transaction per page, `timer.breached` appended and `breach.execute` run for each;
21. `work.breaches` (35.8's breach actions), 22. `close.plan` (35.4), 23. `partner_book.reminders` (33.1 T10),
    24. `partner_book.tape_late` (33.1 T12), 25. `refinance.breach_actions` (35.10), 26. `documents` (35.2 rule 4:
    the staged-blob drain, the envelope expiry, the print vendor probe) — logged;
27. the receipt: `sweep.run_completed` in its own final transaction, satisfying and re-arming
    `SM_SWEEP_HEARTBEAT_DAILY`, and the row set to `completed` with its `passes` and outbox counts.

An exception from a non-logged pass sets the row to `failed` with the message and re-throws; the lease is released
either way.

## The demo clock

Outside production the runtime's clock is the system clock plus a persisted offset (`src/runtime/demo-clock.ts`,
table `demo_clock`, migration 0120 — append-only, the latest row is the current offset), so the demo can be walked
through days and months in minutes and the timers, statements, late charges, the daily refinance run and the borrower
flows fire as they would. The once-a-minute `sweep` job and `seed-demo` read the offset at start; every `serve`
instance reads it at start and then **follows** the table — one indexed `LIMIT 1` read a second — because the service
runs 1..10 instances and only the one that took the POST steps the clock, so the API, the console, the sweeps and the
flows on every instance agree on the instant within a second. Both routes take the ops bearer token and answer **403
in production** (`ENVIRONMENT=production` runs on the system clock, full stop).

- `GET /v1/demo/clock` → `{ now, real_now, offset_ms, offset_days, date, zone, rows, latest, following, max_advance_days, default_budget_ms }`.
- `POST /v1/demo/advance` with `{ "days": 45 }` or `{ "to": "2026-10-25T16:00:00Z" }` (exactly one; `actor` and
  `budget_ms` optional). For every America/New_York calendar day crossed the clock steps to that day (noon ET) and
  runs the sweep minute with one reordering against the wall clock's (35.3 rule 10; `runSweepMinute` in
  `src/runtime/demo-clock.ts`): first 35.3's cycles pass, ahead of the flows' tick — the persisted offset re-read,
  `cycles.plan{as_of: step.at}` planned by `demo:<advance_id>`, the day's queued units drained to completion inline with
  no 240 s budget — then the borrower flows' `tick` and `settle` (every flow's scheduled pass: `originationDailySweep`,
  `servicingDailySweep` — 2.1 posting, the 2.7 late-charge runs, the 2.3 amount check — and the December
  `irs_estatement` ask, `delinquencyDailySweep` — the 11.x counter — the card expiries), then
  `runtime.sweep(step.at, { cycles: "skip" })` — the passes of "The sweep" above with its own cycles pass skipped: the
  refinance daily run, the FAKE reviewers, the breach pass and the rest — then the flows settle once more so the
  reactions the breaches queued have run before the step is reported — and last steps to the target and runs it once
  more. Each step is one `demo_clock` row written before its passes, so a crash leaves the clock on the last swept
  day. A single advance covers at most 400 days; a target at or before now is a no-op (`advanced: false`, nothing
  written), so re-posting the same target changes nothing; the clock never moves backwards. The answer lists every
  step with what it ran.
- **Long advances.** The whole advance runs inside the one request. Forty-five steps take about five seconds on the
  demo book with the FAKE feed; with the refinance run and the reviewers a 400-day advance can outlive Cloud Run's
  request timeout (the deploy sets none, so the default 300 s applies). So an advance spends at most `budget_ms`
  stepping (default 240 s; the body may lower it) and then stops *between* steps, answering `complete: false`,
  `steps_remaining` and the clock standing on the last swept day; re-POST the same `to` (or `GET /v1/demo/clock`
  first, then `to`) and it carries on from there. The same recovery holds if a request is cut off outright: the
  per-step row means nothing is lost but the answer, and the next POST resumes from the last row.

```bash
curl -H "Authorization: Bearer $TOKEN" https://demo.supermortgage.com/v1/demo/clock
curl -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  https://demo.supermortgage.com/v1/demo/advance -d '{"days": 45}'
# a year, in request-sized pieces: repeat until the answer says "complete": true
curl -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  https://demo.supermortgage.com/v1/demo/advance -d '{"to": "2027-09-10T16:00:00Z"}'
```

The proof is `node --test src/runtime/demo-clock.test.ts` on its own database (`supermortgage_demo_clock_test`, created
and migrated by the test): the demo batch boards, 45 days advance, every boarding-armed clock that fell due breached on
its own day, a second advance to the same instant is a no-op, a new Runtime reads the persisted offset and a following
clock adopts another instance's advance unasked, and a spent budget stops between steps and resumes on the next POST.

## The daily refinance check (20.1 `SM_REFI_TRIGGER_DAILY`)

Every sweep (the `supermortgage-sweep` job each minute, and `POST /v1/sweep`) runs
`src/runtime/refi-daily.ts` as its third pass, after `outbox.dispatch` and `cycles` and before
the breach pass ("The sweep" above). A rate feed is always wired (`rateFeedFromEnv` in
`src/runtime/main.ts`): the FAKE unless `RATE_FEED=fred`. Once per calendar day, at or after
06:30 America/New_York, it:

1. publishes the day's rate sheet through `20.4 publishRateSheet` (`rs-<date>-<vendor>`,
   once per day) from the rate feed — the FAKE feed (`src/infra/integrations/rates.ts`,
   the 20.1 worked-example grid, the same every day) unless `RATE_FEED=fred`, which reads
   Freddie Mac's weekly 30-year average from FRED's `MORTGAGE30US` series over https
   (`FRED_API_KEY` optional: with a key the JSON API, without it the public CSV;
   `FRED_SERIES` optionally names another series) and
   builds the sheet's grid around it; `RATE_FEED_FAKE_SHIFT_BPS=-25` moves the FAKE grid;
2. builds the universe from the investor-blind view `v_refi_universe` — every active loan
   on the book, joined at run time to the ledger balance, unpaid installments, the boarding
   flags, the escrow lines and the origination record, with the vendor facts (AVM value,
   score on file) from the loan's `refi_universe` row or a FAKE fallback (indexed
   origination value at `confidence=low`); rows that changed go through
   `20.1 loadUniverse{op=load_row}`; the pass refuses if the view exposes an investor column;
3. runs `20.1 emitOfferReady{op=run, trigger_kind=scheduled}` per partner program and writes
   the `20.1 writeDecision` row per opportunity; `refi.trigger.run_completed` satisfies
   `SM_REFI_TRIGGER_DAILY` (the day's clock, re-armed for tomorrow 06:30). A run that cannot
   start (no matrix, no sheet, feed down with no sheet in force) is logged and the clock
   breaches at 06:30 the next day — sev 3 to compliance-sentinel, the spec's breach action;
4. logs one line: `refi daily <date>: sheet=… programs=… universe=N evaluated=M offers=K suppressed={…}`
   (`gcloud logging read 'jsonPayload.message="refi daily run"'`).

What it needs on the book: a `partner_programs` row, 20.4's LLPA matrix and a cost schedule —
`seed-demo` / `POST /v1/entry/seed-demo` writes all three (FAKE, idempotent) beside the demo
sheet. The 32.11 flow reacts to `refi.opportunity.offer_ready` in the same process (the job
starts the borrower flows for its pass): the MLO of record's review is requested, and once
20.2 has sent the offer and the review is approved, the borrower's OfferCard appears.

## FAKE reviewers (DELTA-30)

Under `INTEGRATIONS=fake` every human role a borrower journey waits on is filled by a FAKE
that approves after `FAKE_REVIEWER_DELAY_S` seconds (default 20), on every sweep, through the
same bus tools a person uses, as `human:FAKE:<role>` — the MLO of record's terms review
(`20.3 requestQuote{op=review}`; the 21.1 stage package `21.1 openEscalation{op=decide}`),
the underwriting reviewer (`21.6 openReviewerEscalation{op=decide}` / `23.3 openEscalation{op=complete}`),
QC's prefunding hold (`28.1 openReview` + `closeReview{no_defect}`), the funding approver's
wire release (`26.3 prepareWire{op=release}`), and the person a transfer reaches
(`20.3 deliverDisclosure{op=human_joined}` on a lead, `4.3 human.transfer{op=complete}` on a loan
or application); any other escalation a FAKE role owns is completed the way the console's
queue completes it. The FAKE officer also approves the 33.1 partner-book offers
(`fakeOfficerFromEnv` in `src/runtime/partner-book-offers.ts`: never in production, nor under
`FAKE_REVIEWERS=off`, nor under any `INTEGRATIONS` other than `fake`). Queues, roles, guardrails
and decision rows are unchanged — the review id
is `FAKE-MR-…`, the person's name "FAKE reviewer (Supermortgage)", the notes say "FAKE reviewer",
and the console's queue row of a pending item a FAKE will fill reads "— FAKE reviewer".
`FAKE_REVIEWERS=off` leaves every queue to a person. Timer breaches (`sev1`–`sev4`
escalations) are never auto-closed. Source: `src/infra/integrations/reviewers.ts`.

## Origination: applications over HTTP

Origination runs on the same service. `POST /v1/applications` opens an application (the 21.1 aggregate: partner,
channel, transaction type, occupancy, borrowers, subject property, the prior loan for a refinance) and returns the
row with `application.started` and the origination timers it armed; `POST /v1/applications/{id}/tools/{process}/{name}`
executes an agent tool in application scope (same body as the loan route); `GET /v1/applications/{id}` reads the
record (row, events, open timers, decisions) and, once 30.2 has funded it, the `loan_id` it became;
`GET /v1/applications` lists the newest applications. A loan created
from an application answers on the loan routes like any transferred-in loan.

The origination tools run against the runtime's own service set (see ARCHITECTURE.md, "One product"): one instance
per process of the stateful section services (CD, commitment, delivery, tolerance, companion disclosures) and the
vendor fakes (`INTEGRATIONS=fake` — credit reseller, DU, identity / OFAC / fraud, AMC, UCDP, title, eRegistry, RON,
EarlyCheck, PE–WL, warehouse). Two runtime routes bridge what the tool surface does not carry yet:
`POST /v1/applications/{id}/disclosures/le` (the initial LE rendered, MLO-approved, delivered and received through
21.2's service; the actor must be the `mlo_of_record`) and `POST /v1/applications/{id}/fund`, which reads 26.3's
`loan.funded`, 26.1's note hash, 26.2's consummation and MIN from the application's record before falling back to the
demo fixture for what the record does not state. Money in every tool `input` is a decimal string of cents.

The end-to-end proof is `node --test src/runtime/lifecycle.test.ts` on its own database, cloned from the migrated
template by src/infra/db/test-db.ts (`REQUIRE_DB=1` to insist on Postgres): one borrower from the refinance
trigger on the existing loan through funding, boarding, purchase, payment, payoff and the next refinance, every step
over HTTP. It is re-runnable against the same database: entity ids are platform-wide, so the fixture ids it writes in
loan or application scope carry a per-run suffix.

## Borrower API

The borrower surface (`apps/borrower`, docs/ux) talks to the same service on `/v1/borrower/*` and `/v1/webhooks/*`
(src/runtime/borrower/routes.ts; the route list is in the comment block at the top of src/runtime/server.ts). Those
routes never accept `API_TOKEN`: a borrower authenticates with a one-time code or a passkey and carries a session token
(`sessions`, migration 0111 — 30 minutes idle before funding, 7 days with a passkey in servicing; money movement needs a
code verified within 10 minutes). Every response passes the allow-list serializer (src/runtime/borrower/serialize.ts)
and every refusal is `{ code, gate?, copy_key }`.

Environment: `ENVIRONMENT=production` turns off the FAKE code echo (below); `BORROWER_RP_ID` (WebAuthn relying-party id,
default `localhost`) and `BORROWER_ORIGINS` (comma-separated allowed origins) must name the borrower app's host;
`BORROWER_APP_URL` is the base of the vendor return routes (`/return/{vendor}/{card_instance_id}`).
`BORROWER_URL_SECRET` signs the short-lived document URLs. **When it is unset the secret is random per process**
(`randomBytes(32)` in `src/runtime/borrower/routes.ts`), Terraform does not set it (`borrower_api_env` in
`infra/terraform/run.tf` carries the four variables above and the staff bootstrap ones, nothing else) and
`max_instances` defaults to 10, so today a signed document URL minted by one instance is refused by another: a
borrower whose next request lands elsewhere gets a refusal, not the bytes. Setting the secret on the API service is
the fix.

**Every vendor behind the borrower API is a FAKE in nonprod.** Each one is a port with an in-memory test double that
logs `vendor: "FAKE"`; the swap is one constructor argument on `createApiServer({ borrower: { … } })`:

| What | FAKE today | Marker | Swap for |
|---|---|---|---|
| One-time codes (SMS / e-mail) | `FakeEdelivery` (src/infra/integrations/delivery.ts) — the platform's own e-delivery port carries the code; the response says `delivery: "FAKE"` and, outside production, echoes the code as `fake_code` | log `borrower.otp.requested … vendor: "FAKE"` | a real `EdeliveryPort` (Twilio / SES) wired through `Runtime.ports.edelivery` — the same swap the notices need |
| Stripe Identity (L3) | `FakeStripeIdentity` (src/runtime/borrower/vendors/fake-stripe-identity.ts): sessions `vs_FAKE_…`, the webhook needs `stripe-signature: FAKE`, the "document" reads back the application's own name / DOB / address | log `stripe_identity … vendor: "FAKE"`; response `delivery: "FAKE"` | a `StripeIdentityPort` over VerificationSessions.create + `Stripe-Signature` HMAC verification with `STRIPE_WEBHOOK_SECRET` |
| Assets connector (`ConnectCard{vendor=plaid_assets}`, 22.4 supplier `plaid`) | `FakePlaid` (src/runtime/borrower/vendors/fake-plaid.ts): a session completes on the tap (`fake_complete`, 32.17 rule 19) or on the webhook `asset_report.ready`; the report is deterministic — two accounts and twelve months of payroll deposits from the fixture employer — and is what the FAKE DU validates income and assets against | every call logs `vendor: "FAKE"` | an `AssetsConnectPort` over Plaid Link + the Assets API (`/asset_report/create` with `days_requested` 365, the `PRODUCT_READY` webhook, the report token as the DU validation service identifier) |
| Payroll / income connector (`ConnectCard{vendor=truv_income}`, 22.3 supplier TRUV) | `FakeTruv` (src/runtime/borrower/vendors/fake-truv.ts): a session completes on the webhook `voie.report.ready`; the report is deterministic (employer, pay frequency, monthly base and variable pay, year-to-date) unless the webhook body overrides it | every call logs `vendor: "FAKE"` | an `IncomeConnectPort` over the Truv API (Link tokens, `verification.report` webhooks with the Truv-Signature HMAC) |
| Passkey attestation | src/runtime/borrower/webauthn.ts verifies challenges, rpIdHash, flags, signCount and the ES256 / RS256 signature for real; the attestation *statement* is accepted unverified | `attestation_verified: "FAKE"` in the registration response | `@simplewebauthn/server` (`verifyRegistrationResponse` / `verifyAuthenticationResponse`) if attestation policy matters |
| Document bytes | `FakeBlobStore` (src/runtime/borrower/vendors/fake-blob-store.ts): in memory, per instance; `documents.storage_uri = fake-blob://…` | `metadata.blob_store = "fake-blob"` | a `BlobStorePort` over Cloud Storage (CMEK bucket per environment; signed URLs minted by the service account) |

What is real regardless of the fakes: the `sessions` / `auth_challenges` / `passkey_credentials` rows, party scoping
(02 §6) through `application_borrowers.party_id` / `borrowers.party_id` / `loan_parties`, the 22.6 `verifyIdentity`
command the webhook executes on the bus (`identity.verified` satisfies `SM_IDENTITY_IAL2_GATE`), the
`application_borrowers.prefill` rows it writes as `source = stripe_identity` pending the borrower's confirmation, the
22.1 `ingestDocument` command an upload executes, `ui_events`, and the `esign_portal` notice channel (DELTA-08:
`notice_deliveries.card_instance_id` beside `rendered_document_id`).

The proof is `node --test src/runtime/borrower/borrower.test.ts` on its own database from src/infra/db/test-db.ts.

## 7. What is and is not real in nonprod

- **`INTEGRATIONS=fake`.** `INTEGRATIONS` is `fake` or `real`; any other value refuses at
  start (`src/runtime/config.ts`, 35.12 rule 4). Under `fake` — what `run.tf` sets on
  nonprod — every vendor integration (lockbox/BAI2, e-OSCAR, P360/SMDU/LSDU,
  print-and-mail, e-vault, MERS, and the rest) is a test double inside the container;
  nothing is reported to a bureau or to Fannie Mae. A process whose `ENVIRONMENT` is
  `production` (or `prod`) refuses `fake` at start with `NO_FAKE_IN_PRODUCTION`
  (`config.ts`; `buildPorts` in `src/domain/operations-runtime/posture-35-12/real-ports.ts`).
- **`INTEGRATIONS=real`** reads each vendor's mode from the `integration_switches` table
  (`real-ports.ts` `switchesInForce`): fifteen vendors are switchable (`VENDOR_PORTS`), a
  vendor with no row — or switched `off` — gets an `OffPort` whose every call answers
  `VENDOR_OFF{vendor}`, a vendor switched `fake` keeps its FAKE (never in production), and a
  vendor switched `real` with no adapter in this build answers `REAL_ADAPTER_MISSING{vendor}`
  per call, nothing attempted, nothing written. The one real adapter in the tree is
  `RealLockbox` for `lockbox_bai2` (`REAL_ADAPTER_VENDORS`), which reads the bank portal's
  `{url, token}` from the `GcpSecretManager` vault (Secret Manager over REST under the
  metadata server's token) — so today `real` means one real vendor and fourteen switches
  that refuse by name.
- **What leaves the environment.** With the placeholder `unset` in the FRED, Anthropic and
  Tavus settings nothing leaves the environment. Once set, these calls go out: `RATE_FEED=fred`
  reads FRED's `MORTGAGE30US` series over https once a day for the rate sheet (`src/infra/integrations/rates.ts`);
  a real `supermortgage-anthropic-api-key` version sends Talk turns and the 32.16 agent turns to
  Anthropic's Messages API ("The borrower surfaces" below); a real `supermortgage-tavus-api-key`
  version creates video conversations at Tavus and takes its callbacks; and a real OAuth client
  sends Sign in with Google to Google's discovery, token and JWKS endpoints.
- **Do not load borrower data.** Nonprod has no data-classification controls,
  its access is a single shared bearer token, and its logs are readable by
  everyone with project Viewer. Use synthetic loans only.
- **The deployer role set is broad** (`roles/editor` plus several admin roles)
  so the first Terraform run can create everything. That is acceptable for a
  throwaway nonprod project and not for anything holding real data.
- **Cloud Armor WAF rules are in preview**: SQLi/XSS signatures are logged,
  not enforced. The rate limit (1200 requests per 60 s per IP; raised from 300 once the Apply product's polling from three sessions on one address tripped it) is enforced.
- **Cloud SQL has a public IP with no authorized networks.** Only the Cloud
  Run socket path (IAM-authorized) can reach it, and `ssl_mode = "ENCRYPTED_ONLY"`
  refuses plaintext even on the socket path. Prod should not have a public IP at all.

### Path to prod

A separate project (`supermortgage-prod`), a second run of `bootstrap.sh`
there, and the same workflow with `environment=prod`, plus:

1. Cloud SQL on private IP only (`ipv4_enabled = false`, a VPC + Private
   Service Access, Cloud Run Direct VPC egress), `availability_type = "REGIONAL"`.
2. IAP or the identity provider in front of `demo.supermortgage.com`;
   per-user identities in place of the shared bearer token.
3. Narrow the deployer: drop `roles/editor`, keep only the admin roles for the
   resource types Terraform manages, and consider a separate, read-only plan
   identity for pull requests.
4. CMEK on the Artifact Registry repository and on any Cloud Storage buckets
   the application gains.
5. Cloud Armor rules out of preview, with an allowlist for known partner IPs.
6. `INTEGRATIONS=real` with a real adapter per vendor behind its own secret and
   egress rule, each thrown with `integrations.switch` — a production process
   refuses `fake` at start, and a `real` switch with no adapter refuses per call
   (§7 above).
7. Org policies: `iam.allowedPolicyMemberDomains`, `sql.restrictPublicIp`,
   `compute.requireShieldedVm`, and audit-log sinks to a locked bucket.

## Troubleshooting

**"Billing is not enabled" from bootstrap.sh.** Step 1.4 was skipped. Link a
billing account at
<https://console.cloud.google.com/billing/linkedaccount?project=supermortgage-nonprod>
and re-run the script.

**Terraform fails with `constraints/iam.allowedPolicyMemberDomains`** on
`google_cloud_run_v2_service_iam_member.public_invoker`. Your Google Cloud
organization has the "Domain restricted sharing" policy on, which forbids
granting `allUsers` anything. The load balancer needs the Cloud Run service to
be invokable without an identity token (ingress is still restricted to the load
balancer, and the application enforces the bearer token). Remedy, as an
organization admin:

```sh
gcloud resource-manager org-policies disable-enforce constraints/iam.allowedPolicyMemberDomains \
  --project supermortgage-nonprod
```

then re-run the workflow. (Projects created under a personal Google account
have no organization and never hit this.)

**Certificate stuck in `PROVISIONING` / `FAILED_NOT_VISIBLE`.** DNS is not
pointing at the load balancer yet. Check that
`dig +short demo.supermortgage.com`
returns the load balancer IP, then wait up to 60 minutes. The certificate
retries on its own; nothing needs re-running.

**A smoke step warns in the deploy job** — "Smoke test /healthz", "Smoke test
/app (borrower)" or "Smoke test / (302 to /app) and /ops (console)". Same cause
as above; all three are `continue-on-error` for that reason. Re-run the workflow
(or just `curl`) once the certificate is `ACTIVE`. The third step also fails
when `/` or `/video` does not answer 302, `/ops` does not answer 200 or
`/ops/api/me` answers anything but 401 — its log names which.

**The `demo walk` job is red.** The likeliest red job after a green deploy: it
runs the ten outcomes of "The demo walk" (§4) and a walk under ten fails the job,
not the deploy. Open the run's artifact `demo-walk` — the screenshots and
`report.json`, whose `checks[]` name each outcome and its `detail` — and the job
summary's one line per outcome. Outcomes 3–5 NOT ok with
"WALK_OPS_TOKEN not provided" means the token step did not run (in `deploy.yml`
it is read from Secret Manager; in `walk.yml` from the repository secret
`WALK_OPS_TOKEN`, §3). Outcome 9 NOT ok means the partner book is not seeded:
run the deploy with `seed_demo` ticked (or the seed-demo job) and re-run the
walk from `walk.yml`.

**`migrate database` job fails.** Read the job's logs:

```sh
gcloud run jobs executions list --job supermortgage-migrate --region us-central1 --project supermortgage-nonprod --limit 1
gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="supermortgage-migrate"' \
  --project supermortgage-nonprod --freshness 1h --limit 200 --format 'value(timestamp,textPayload)'
```

Common causes: a migration SQL error (fix the migration in a new file, never by
editing an applied one), or `/readyz`-style connectivity problems, which show
as `could not connect to server` and mean the Cloud SQL instance is still
starting or the runtime service account lost `roles/cloudsql.client`.

**Service revision fails to become ready.** Usually the image cannot read a
secret or the database. Check
`gcloud run services describe supermortgage-api --region us-central1 --format 'value(status.conditions)'`
and the service logs above. `/healthz` must answer 200 within 60 seconds of
container start or the startup probe fails.

**Destroying everything.** Cloud SQL is protected against accidental
destruction. In `infra/terraform`, authenticated as yourself in Cloud Shell:

```sh
terraform init -backend-config="bucket=supermortgage-nonprod-supermortgage-tfstate" \
               -backend-config="prefix=supermortgage/nonprod"
terraform apply   -var project_id=supermortgage-nonprod -var db_deletion_protection=false
terraform destroy -var project_id=supermortgage-nonprod -var db_deletion_protection=false
```

Then delete the project itself at
<https://console.cloud.google.com/iam-admin/settings> (**Shut down**), which
also removes the state bucket, the deployer service account and the Workload
Identity pool that `bootstrap.sh` created. Note that a destroyed KMS key
cannot be recovered, so a destroyed database cannot be restored from its
backups either.

## Sign in with Google

Process 32.14 (docs/ux/15) adds Continue with Google to the borrower sign-in
screen: OpenID Connect, Authorization Code + PKCE (S256) on the API
(`POST /v1/borrower/auth/oidc`, `src/runtime/borrower/oidc.ts`). Under
`INTEGRATIONS=fake` — every nonprod build today — the provider is the in-repo
`FakeGoogleOidc` (marked FAKE): the "authorization URL" is the app's own callback
carrying a canned identity, and no Google credential is needed. The real
adapter (`GoogleOidcAdapter`: discovery document, token endpoint, JWKS cache,
RS256 through `node:crypto`) is exercised only once an OAuth client exists.

To create that client, in the Google Cloud console of the project:

1. **APIs & Services → OAuth consent screen**: user type **External**; app name
   Supermortgage; scopes `openid`, `email`, `profile` only (no sensitive scopes,
   no verification needed for these).
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   application type **Web application**;
   authorized JavaScript origin `https://demo.supermortgage.com`;
   authorized redirect URI `https://demo.supermortgage.com/app/auth/google/callback`
   (the borrower app's callback page; the API's `GOOGLE_OAUTH_REDIRECT`
   environment variable in `infra/terraform/run.tf` names the same URL).
3. Put the client id and secret in Secret Manager as **new versions** of the two
   secrets Terraform created with a placeholder first version (a secret with no
   version would keep the Cloud Run revision from starting):

   ```sh
   printf '%s' '<client id>'     | gcloud secrets versions add supermortgage-google-oauth-client-id     --data-file=- --project supermortgage-nonprod
   printf '%s' '<client secret>' | gcloud secrets versions add supermortgage-google-oauth-client-secret --data-file=- --project supermortgage-nonprod
   ```

   The API service reads them as `GOOGLE_OAUTH_CLIENT_ID` /
   `GOOGLE_OAUTH_CLIENT_SECRET` (`latest`); the placeholder value `unset` reads
   as "not configured". Redeploy (or restart the revision) after adding the
   versions.

The id token is verified on the API (`iss` ∈ Google's issuers, `aud` = the
client id, `exp`, `nonce` = the challenge's, the RS256 signature against Google's
JWKS); `email_verified` must be true or the sign-in is refused
(`OIDC_EMAIL_UNVERIFIED`). The stable key is `sub`, kept in `oidc_identities`
(migration 0116); a Google session is L1 without a fresh code, so money movement
still asks for one. Also on the API service: `BORROWER_DEFAULT_PARTNER_ID`
(Terraform variable `borrower_default_partner_id`, DELTA-15) — the Phase I
partner's `parties` row id the organic entry names; leave it empty to use the
newest servicer party that is not Supermortgage itself (the seeded demo partner;
`src/runtime/borrower/partner.ts`). Supermortgage is the subservicer and is never
named as the lender: the servicing batch's own "Supermortgage" servicer party is
skipped by the fallback, `/v1/borrower/me` reads a record that names it as
unnamed (the app then shows `NEXT_PUBLIC_PARTNER_LEGAL_NAME`), and the seed-demo
job creates "Partner Bank (FAKE demo)" when no other servicer party exists.

## The borrower surfaces

**The entry is the Apply product at `/app` (32.19, docs/ux/18).** A browser with no
session sees the door — `welcome` → `intro` ("What is Supermortgage?") → `account`
(`apps/borrower/components/apply/door.tsx`; the owner's decision of 2026-09-16, item 4:
two informational screens precede the account form, nothing personal asked before it) —
then the nine steps `goal`, `property`, `you`, `connect`, `details`, `questions`,
`demographics`, `review`, `result` in one phone column under five tabs: Apply, Chat,
My Loan, Tasks, Account (`components/apply/apply-model.ts`). `/app/sign-up` and
`/app/sign-in` remain as the account screen's two modes (`sign_up` / `sign_in`);
`/app/reset` resets a password; Continue with Google is on the account screen (the
FAKE provider under `INTEGRATIONS=fake`; the real one once the OAuth client exists,
"Sign in with Google" above). The old Thread shell (`apps/borrower/components/shell`,
`Thread.tsx` and the rest) is still in the tree and is not mounted.

**Talk.** `/app/talk` redirects to `/app` (`apps/borrower/app/talk/page.tsx`; the
decision's item 5) and the anonymous minute of 32.14 is retired (the decision's
"What retires" table, the 32.14 row: T1–T6 and T19). `POST /v1/borrower/talk`
(`src/runtime/borrower/talk.ts`) still exists on the API: the model only talks and calls
tools, and without a key the route answers `503 TALK_NOT_CONFIGURED` while everything
else keeps working.

**The video agent (32.17).** `https://demo.supermortgage.com/video` answers 302 →
`/app/video` (`infra/terraform/lb.tf`, beside the `/` → `/app` rule; the deploy
workflow's third smoke step checks it). `/app/video` stays mounted but is linked from
nowhere, so 32.17-T21 stays live (the decision's item 7 and "What stays live"); the
video door, the video stage and the rail beside the call are retired (the decision's
32.17 row). Without a vendor key the FAKE stands in — `FakeTavus`
(`src/infra/integrations/tavus.ts`, `FAKE`, in every build stage); the boot log says
which (`video_agent: "FAKE" | "tavus"`).

Turning the live vendor on takes two secrets, as new versions of the placeholders Terraform created:

```sh
printf '%s' '<tavus api key>' | gcloud secrets versions add supermortgage-tavus-api-key --data-file=- --project supermortgage-nonprod
printf '%s' "$(openssl rand -hex 24)" | gcloud secrets versions add supermortgage-video-callback-secret --data-file=- --project supermortgage-nonprod
```

The API service reads them as `TAVUS_API_KEY` and `VIDEO_CALLBACK_SECRET` (`latest`). The environment
also carries `VIDEO_API_URL` (the public origin the vendor reaches the custom-LLM endpoint and the callback
`https://<api host>/v1/video/tavus/callback/<secret>` on — Terraform sets it to the API hostname),
`VIDEO_BORROWER_CAMERA` (`on`, the default — the camera is on for presence, nothing is recorded; `off`
joins audio-only), and optionally `TAVUS_REPLICA_ID` (a branded replica; unset → the first stock replica
the vendor lists **[UNVERIFIED — the stock-replica listing filter]**) and `VIDEO_JOIN_TIMEOUT_S`
(default 120). Redeploy (or restart the revision) after adding the versions. Nothing about the record ever
reaches the vendor: the persona's system prompt is a one-line pointer, the conversation's context is the
borrower's first name and the partner's name, and the vendor's transcript is kept as a reference on
`video_sessions.transcript_ref`, never as the record.

**The Anthropic key.** One secret powers both Talk and the 32.16 agent turn (Chat), as a
new version of the secret Terraform created with a placeholder first version:

```sh
printf '%s' '<api key>' | gcloud secrets versions add supermortgage-anthropic-api-key --data-file=- --project supermortgage-nonprod
```

The API service reads it as `ANTHROPIC_API_KEY` (`latest`); the placeholder `unset` reads
as "not configured" (`src/runtime/config.ts`). Redeploy (or restart the revision) after
adding the version. Talk takes `TALK_MODEL` (default `claude-opus-5`) and `TALK_EFFORT`
(`low`, the default, `medium` or `high`); the agent turn takes `LLM_MODEL` (falls back to
`TALK_MODEL`), `LLM_EFFORT` (`low`, the default, `medium` or `high`), `LLM_SPEED`
(`standard`, the default, or `fast` for the Messages API's fast mode — Terraform sets it
from the `llm_speed` variable, `infra/terraform/run.tf` / `variables.tf`) and
`LLM_PROMPT_VERSION`. The boot log line `serving` names both as `claude:<model>` or
"not configured".

**The disclosure footer and the partner's name.** The footer on every screen
(docs/ux/17 §1 principle 8: `footer.disclosure` — the AI notice, the partner's name and
NMLS ID, the NMLS consumer access link and `/app/disclosures`) names the partner from the
build arguments `NEXT_PUBLIC_PARTNER_LEGAL_NAME` (repository variable `PARTNER_LEGAL_NAME`,
"Partner Bank" when unset) and `NEXT_PUBLIC_PARTNER_NMLSR_ID` (repository variable
`PARTNER_NMLSR_ID`, "123456" — the demo partner — when unset) because no session exists yet
to read them from (`deploy.yml` "docker build (borrower)"; `Dockerfile.borrower`); once
signed in the footer takes both from `/v1/borrower/me`'s `partner`, as the Apply product
does. Codes are delivered by the e-delivery adapter (the FAKE echoes the code on nonprod,
as the OTP route does). A password session opens without a fresh code, so a money command
still asks for one (`FRESH_L1_COMMANDS` in `src/runtime/borrower/commands.ts`:
`payment.makeOneTime`, `payment.extraPrincipal`, `autodraft.enroll`, `autodraft.change`,
`autodraft.pause`, `autodraft.revoke`, `escrow.electShortage`, `party.updateContact`).

## The partner portal

**The servicing partner's book is at `/partners` (section 36; `apps/partner`).** A browser
with no session sees the door, `/partners/sign-in` (`apps/partner/components/Door.tsx`): the
partner's legal name and NMLSR ID from the image's build args (`NEXT_PUBLIC_PARTNER_LEGAL_NAME`,
`NEXT_PUBLIC_PARTNER_NMLSR_ID` — the repository variables of §3), a six-digit code to the
work e-mail (the FAKE e-delivery port echoes it on the door outside production, as the borrower
and staff doors do), then the password — set on the enrol token at the first sign-in, asked on
every later one. Nothing of the book renders before the session. Past the door: Home, Book,
Eligibility, Pipeline, Reports and, for a `partner_admin`, Admin (docs/partner-portal/
00-CLAUDE-BUILD-INSTRUCTIONS.md §7). Every page runs on `/v1/partner/*`, which a partner
session alone opens (36.1 rule 7: the staff cookie, the header actor and the machine
`API_TOKEN` open nothing there).

**The cookie.** The app's server-side proxy (`apps/partner/app/api/[...path]/route.ts`)
turns a sign-in answer's token into `sm_partner_session` — `HttpOnly`, `Secure` (the image
runs `NODE_ENV=production`), `SameSite=Lax`, `Path=/partners`, no longer than the session's
12-hour absolute limit — and forwards it as `Authorization: Bearer` on `/partners/api/v1/partner/*`
only (`lib/proxy-allow.ts`: `/v1/partner-book/*`, `/ops`, `/v1/borrower/*` and `/v1/video/*`
answer 404 there). The browser never holds a bearer; the service holds no API token
(`infra/terraform/run.tf`: its env is `API_BASE_URL` and `ENVIRONMENT`; `iam.tf`: the `partner`
service account has no Secret Manager grant). A 401 from the API drops the cookie and the
shell returns to the door keeping the return path.

**The seed.** The demo partner's first `partner_admin` is seeded beside the partner book by
the `seed-demo` job (`src/runtime/main.ts seed-demo` → `seedPartnerPortalDemo`, 36.1
Operational prerequisites; the address `partner.admin@northlight.example`, invited, idempotent,
non-production only) — so the portal has a person to sign in as only after a
`workflow_dispatch` with `seed_demo=true` (§4 "Board the demo transfer batch") or
`gcloud run jobs execute supermortgage-seed-demo … --wait`. Until then the door still echoes
a code for that address (no enumeration) and refuses its verification (`OTP_INVALID`), and the
walk below names that as the unseeded demo.

**The walk** (`apps/partner/tests/walk/partner-walk.mts`, the walk job after the borrower
walk; seven outcomes, each a screenshot and a `report.json` line, exit 1 under the count):

1. A fresh window at `/partners` reaches the door — `/partners/sign-in?return=/partners`,
   the partner named on the door, no loan, no cookie.
2. The seeded `partner_admin` signs in — the echoed code, the password (set at enrolment on
   the first walk against a seed, `WALK_PARTNER_PASSWORD` or its deterministic default;
   entered on every later walk); Home opens under the partner's legal name from
   `GET /v1/partner/me` with the nav in its fixed order and Admin; the cookie's flags.
   Unseeded: "the seeded partner_admin is absent: dispatch seed_demo".
3. Home shows the monitored count (12 after the seed) and the three bucket counts, equal to
   `GET /v1/partner/home` through the page's proxy; the tape as-of and in-flight.
4. Eligibility's three buckets sum to monitored − on hold; three tabs, the state filter and
   no other; each tab lists its count.
5. A monitored loan's page shows "Monitored — <legal name> remains servicer" with the name
   the shell read, and no Pay, Escrow, Draft or other servicing control.
6. The Serviced tab is visible and disabled with the 36.6 copy.
7. Sign out returns to the door, the cookie is gone, a second fresh context sees the door.

The tape re-upload and the `partner_ops` invitation of the local walk
(`src/domain/servicing-partner-portal/36-app.walk.test.ts`, run at landing and in CI) are
not repeated on the deployed demo: the fixture tape is built by a module `apps/partner` does
not ship, and an invitation would leave a new person on the tenant after every deploy.

## The conversation trace (docs/ux/17 §6, DELTA-28's console view)

Two read-only routes on the ops console API (src/console/server.ts, on a staff session holding an ops role —
`ops_analyst`, `officer` or `compliance`; an `admin`-only session is 403 `ROLE_REQUIRED` on every borrower read
(34.1 rule 2) — or, outside production only, the `x-actor-id` / `x-actor-role` headers together with the
`API_TOKEN` bearer (the deploy workflow's smoke calls; in production the headers open nothing); every read is
access-logged with the address masked): `GET /api/ai/conversation?party_id=<uuid>` or `?email=<address>` returns, for one borrower, in
order, the thread (`messages`: message_id, at, sender, sender_ref, body_text, card_instance_id, copy_tokens),
every card (`cards`: card_instance_id, kind, copy_key, status, `props.proposal`, `evidence.option_id`,
created_at, resolved_at) and every `agent_turns` row (`turns`: turn_id, message_id, reply_message_id,
model_version, prompt_version, tool_calls, guard_result, safe_classification, latency_ms, tokens_in/out,
created_at) joined so each turn shows the borrower text it answered (`borrower_text`) and the reply it produced
(`reply_text`); `GET /api/ai/conversation/recent?limit=20` lists the most recent turns across parties with the
party's e-mail masked to its first two characters (`ca***`). The console page at `/ops` renders the listing
under Oversight → AI conversations, each row linking to the per-party trace. The proof is
`node --test src/console/ai-conversation.test.ts` (its own database, the scripted model).
