# Deploying Supermortgage to Google Cloud (nonprod)

This is the owner's runbook. It assumes you have never used Google Cloud. Follow
the steps in order; each one tells you exactly what to click or paste.

What you end up with, in one Google Cloud project:

| Piece | What it is |
|---|---|
| Cloud Run service `supermortgage-api` | the HTTP server (`serve` mode), 1..10 instances |
| Cloud Run job `supermortgage-migrate` | applies `db/migrations/*.sql`; run before every deploy |
| Cloud Run job `supermortgage-sweep` | one pass over due timers and the outbox; Cloud Scheduler runs it every minute |
| Cloud SQL (PostgreSQL 16) `supermortgage-nonprod` | the database, encrypted with a customer-managed key, daily backups + point-in-time recovery |
| Secret Manager | `supermortgage-database-url`, `supermortgage-api-token` |
| Artifact Registry `supermortgage` | container images built by GitHub Actions |
| Global HTTPS load balancer + Cloud Armor | `demo.supermortgage.com` (API and console on one name), Google-managed certificate, rate limiting |
| Cloud Run service `supermortgage-borrower` | the borrower app (`apps/borrower`, Next.js standalone from `Dockerfile.borrower`), served at `https://demo.supermortgage.com/app` by a `/app/*` URL-map rule to its own serverless NEG — infrastructure and the second build/deploy job are in `docs/ux/deploy-borrower.patch`, applied after review |

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
(about $50/month), one always-on Cloud Run instance (about $30/month), the load
balancer forwarding rules (about $18/month), plus cents for the rest.

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

## 3. Set the five GitHub repository variables

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
sensitive, and there are no keys to store anywhere.

## 4. Run the deploy workflow

Either push a commit to `main` or to
`claude/mortgage-subservicer-builder-y9nr7e`, or run it by hand:

1. Open <https://github.com/doug-ludlow/Supermortgage/actions/workflows/deploy.yml>.
2. Click **Run workflow**, leave `environment` as `nonprod`, click the green
   **Run workflow** button.

The jobs run in order: `preflight` (checks the variables), `terraform`
(creates everything in Google Cloud; the first run takes 15-25 minutes, mostly
Cloud SQL), `build image`, `migrate database`, `deploy`.

The `deploy` job's **Summary** (click the run, then the summary at the top)
prints the load balancer IP and the DNS records for the next step. The
"Smoke test" step is expected to show a warning on the first run: it cannot
pass until DNS and the certificate are in place.

## 5. Point DNS at the load balancer (GoDaddy)

Only two hostnames move to Google Cloud. The apex `supermortgage.com`, `www`,
email and anything else on the domain stay exactly where they are.

1. Log in at <https://dcc.godaddy.com/manage/> (My Products), find
   **supermortgage.com** and click **DNS** (on the cPanel-hosted product page it
   is **Domain -> Manage DNS**).
2. Click **Add New Record** twice and enter, using the IP from the workflow
   summary (or `terraform output load_balancer_ip`):

   | Type | Name | Value | TTL |
   |---|---|---|---|
   | A | `api` | `<load balancer IP>` | 600 seconds |
   | A | `console` | `<load balancer IP>` | 600 seconds |

   If an `api` or `console` record already exists, edit it instead of adding a
   duplicate.
3. Wait. DNS propagates in a few minutes; the Google-managed certificate then
   provisions itself, which takes anywhere from 10 to 60 minutes. Check with:

   ```sh
   gcloud compute ssl-certificates describe supermortgage-cert \
     --project supermortgage-nonprod --format 'value(managed.status,managed.domainStatus)'
   ```

   You want `ACTIVE` and both domains `ACTIVE`. `PROVISIONING` means keep
   waiting; `FAILED_NOT_VISIBLE` means the DNS records are not pointing at the
   load balancer yet.

## 6. Verify

From any machine:

```sh
curl -i https://demo.supermortgage.com/healthz     # HTTP/2 200
curl -i https://demo.supermortgage.com/readyz      # 200 once Postgres answers
curl -i https://demo.supermortgage.com/            # 401 without a token
```

Read the API token (generated by Terraform and stored in Secret Manager) in
Cloud Shell:

```sh
gcloud secrets versions access latest --secret supermortgage-api-token --project supermortgage-nonprod
```

and use it:

```sh
TOKEN="$(gcloud secrets versions access latest --secret supermortgage-api-token --project supermortgage-nonprod)"
curl -H "Authorization: Bearer ${TOKEN}" https://demo.supermortgage.com/
```

The console is at <https://demo.supermortgage.com/> and needs the same
bearer token.

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

Your own batch goes to `POST /v1/transfers/batches` with `{ actor, batch, files }`, where
`files` carries the tape CSV texts in the layout documented in
`fixtures/transfer-batch-demo/LAYOUT.md`; `GET /v1/transfers/batches/<batch_id>` returns the
scorecard afterwards.

## Origination: applications over HTTP

Origination runs on the same service. `POST /v1/applications` opens an application (the 21.1 aggregate: partner,
channel, transaction type, occupancy, borrowers, subject property, the prior loan for a refinance) and returns the
row with `application.started` and the origination timers it armed; `POST /v1/applications/{id}/tools/{process}/{name}`
executes an agent tool in application scope (same body as the loan route); `GET /v1/applications/{id}` reads the
record (row, events, open timers, decisions) and, once 30.2 has funded it, the `loan_id` it became. A loan created
from an application answers on the loan routes like any transferred-in loan.

The origination tools run against the runtime's own service set (see ARCHITECTURE.md, "One product"): one instance
per process of the stateful section services (CD, commitment, delivery, tolerance, companion disclosures) and the
vendor fakes (`INTEGRATIONS=fake` — credit reseller, DU, identity / OFAC / fraud, AMC, UCDP, title, eRegistry, RON,
EarlyCheck, PE–WL, warehouse). Two runtime routes bridge what the tool surface does not carry yet:
`POST /v1/applications/{id}/disclosures/le` (the initial LE rendered, MLO-approved, delivered and received through
21.2's service; the actor must be the `mlo_of_record`) and `POST /v1/applications/{id}/fund`, which reads 26.3's
`loan.funded`, 26.1's note hash, 26.2's consummation and MIN from the application's record before falling back to the
demo fixture for what the record does not state. Money in every tool `input` is a decimal string of cents.

The end-to-end proof is `node --test src/runtime/lifecycle.test.ts` against a migrated `supermortgage_test` database
(`DATABASE_URL=postgresql://sm:sm@localhost/supermortgage_test db/migrate.sh`): one borrower from the refinance
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
`BORROWER_URL_SECRET` signs the short-lived document URLs (random per process when unset — set it when there is more
than one instance); `BORROWER_APP_URL` is the base of the vendor return routes (`/return/{vendor}/{card_instance_id}`).

**Every vendor behind the borrower API is a FAKE in nonprod.** Each one is a port with an in-memory test double that
logs `vendor: "FAKE"`; the swap is one constructor argument on `createApiServer({ borrower: { … } })`:

| What | FAKE today | Marker | Swap for |
|---|---|---|---|
| One-time codes (SMS / e-mail) | `FakeEdelivery` (src/infra/integrations/delivery.ts) — the platform's own e-delivery port carries the code; the response says `delivery: "FAKE"` and, outside production, echoes the code as `fake_code` | log `borrower.otp.requested … vendor: "FAKE"` | a real `EdeliveryPort` (Twilio / SES) wired through `Runtime.ports.edelivery` — the same swap the notices need |
| Stripe Identity (L3) | `FakeStripeIdentity` (src/runtime/borrower/vendors/fake-stripe-identity.ts): sessions `vs_FAKE_…`, the webhook needs `stripe-signature: FAKE`, the "document" reads back the application's own name / DOB / address | log `stripe_identity … vendor: "FAKE"`; response `delivery: "FAKE"` | a `StripeIdentityPort` over VerificationSessions.create + `Stripe-Signature` HMAC verification with `STRIPE_WEBHOOK_SECRET` |
| Passkey attestation | src/runtime/borrower/webauthn.ts verifies challenges, rpIdHash, flags, signCount and the ES256 / RS256 signature for real; the attestation *statement* is accepted unverified | `attestation_verified: "FAKE"` in the registration response | `@simplewebauthn/server` (`verifyRegistrationResponse` / `verifyAuthenticationResponse`) if attestation policy matters |
| Document bytes | `FakeBlobStore` (src/runtime/borrower/vendors/fake-blob-store.ts): in memory, per instance; `documents.storage_uri = fake-blob://…` | `metadata.blob_store = "fake-blob"` | a `BlobStorePort` over Cloud Storage (CMEK bucket per environment; signed URLs minted by the service account) |

What is real regardless of the fakes: the `sessions` / `auth_challenges` / `passkey_credentials` rows, party scoping
(02 §6) through `application_borrowers.party_id` / `borrowers.party_id` / `loan_parties`, the 22.6 `verifyIdentity`
command the webhook executes on the bus (`identity.verified` satisfies `SM_IDENTITY_IAL2_GATE`), the
`application_borrowers.prefill` rows it writes as `source = stripe_identity` pending the borrower's confirmation, the
22.1 `ingestDocument` command an upload executes, `ui_events`, and the `esign_portal` notice channel (DELTA-08:
`notice_deliveries.card_instance_id` beside `rendered_document_id`).

The proof is `node --test src/runtime/borrower/borrower.test.ts` against a migrated `supermortgage_test`.

## 7. What is and is not real in nonprod

- **`INTEGRATIONS=fake`.** Every vendor integration (lockbox/BAI2, e-OSCAR,
  P360/SMDU/LSDU, print-and-mail, e-vault, MERS) is a test double inside the
  container. Nothing leaves the environment; nothing is reported to a bureau or
  to Fannie Mae. `fake` is the only value that exists today.
- **Do not load borrower data.** Nonprod has no data-classification controls,
  its access is a single shared bearer token, and its logs are readable by
  everyone with project Viewer. Use synthetic loans only.
- **The deployer role set is broad** (`roles/editor` plus several admin roles)
  so the first Terraform run can create everything. That is acceptable for a
  throwaway nonprod project and not for anything holding real data.
- **Cloud Armor WAF rules are in preview**: SQLi/XSS signatures are logged,
  not enforced. The rate limit (300 requests/minute per IP) is enforced.
- **Cloud SQL has a public IP with no authorized networks.** Only the Cloud
  Run socket path (IAM-authorized, TLS-only) can reach it. Prod should not
  have a public IP at all.

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
6. Real `INTEGRATIONS` adapters, each behind its own secret and egress rule.
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
pointing at the load balancer yet, or only one of the two names is. Check
`dig +short demo.supermortgage.com`
both return the load balancer IP, then wait up to 60 minutes. The certificate
retries on its own; nothing needs re-running.

**Smoke test warning in the deploy job.** Same cause as above; it is
`continue-on-error` for that reason. Re-run the workflow (or just `curl`) once
the certificate is `ACTIVE`.

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
