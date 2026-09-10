#!/usr/bin/env bash
# =============================================================================
# Supermortgage — one-time Google Cloud bootstrap
#
# Run this ONCE per project from Google Cloud Shell (it already has gcloud and
# is authenticated as you). It is idempotent: every create is guarded by a
# describe/list check, so re-running it is safe.
#
#   PROJECT_ID=supermortgage-nonprod bash infra/bootstrap.sh
#
# What it does:
#   1. points gcloud at the project and checks billing is attached
#   2. enables the APIs Terraform itself needs
#   3. creates the GCS bucket that holds Terraform state
#   4. creates the `supermortgage-deployer` service account and its roles
#   5. creates a Workload Identity Federation pool + GitHub OIDC provider so
#      GitHub Actions can act as that service account WITHOUT any key file
#   6. prints the GitHub repository *variables* you must set
#
# Everything else (Cloud SQL, Cloud Run, load balancer, secrets, ...) is
# created by Terraform from the GitHub deploy workflow.
# =============================================================================
set -euo pipefail

# ---- inputs ----------------------------------------------------------------
if [[ -z "${PROJECT_ID:-}" ]]; then
  read -r -p "Google Cloud project ID (e.g. supermortgage-nonprod): " PROJECT_ID
fi
: "${PROJECT_ID:?PROJECT_ID is required}"
REGION="${REGION:-us-central1}"
GITHUB_REPO="${GITHUB_REPO:-doug-ludlow/Supermortgage}"
TF_STATE_BUCKET="${TF_STATE_BUCKET:-${PROJECT_ID}-supermortgage-tfstate}"

DEPLOYER_SA_NAME="supermortgage-deployer"
DEPLOYER_SA="${DEPLOYER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
WIF_POOL="github"
WIF_PROVIDER="github"

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m%s\033[0m\n' "$*"; }
skip() { printf '    \033[33m%s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

command -v gcloud >/dev/null || die "gcloud is not installed. Run this from Google Cloud Shell (https://shell.cloud.google.com)."

# ---- 1. project + billing ---------------------------------------------------
log "Selecting project ${PROJECT_ID}"
gcloud projects describe "${PROJECT_ID}" --format='value(projectId)' >/dev/null 2>&1 \
  || die "Project '${PROJECT_ID}' does not exist or you cannot see it. Create it at https://console.cloud.google.com/projectcreate first."
gcloud config set project "${PROJECT_ID}" >/dev/null
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
ok "project number ${PROJECT_NUMBER}"

log "Checking billing"
BILLING_ENABLED="$(gcloud billing projects describe "${PROJECT_ID}" --format='value(billingEnabled)' 2>/dev/null || echo "False")"
if [[ "${BILLING_ENABLED}" != "True" ]]; then
  die "Billing is not enabled on ${PROJECT_ID}.
    Open https://console.cloud.google.com/billing/linkedaccount?project=${PROJECT_ID}
    link a billing account, then re-run this script. Nothing below can be created without billing."
fi
ok "billing is enabled"

# ---- 2. APIs Terraform needs ------------------------------------------------
log "Enabling the APIs Terraform needs (this can take a minute)"
gcloud services enable \
  serviceusage.googleapis.com \
  cloudresourcemanager.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  storage.googleapis.com \
  compute.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  sqladmin.googleapis.com \
  cloudkms.googleapis.com \
  cloudscheduler.googleapis.com \
  --project "${PROJECT_ID}"
ok "APIs enabled"

# ---- 3. Terraform state bucket ----------------------------------------------
log "Terraform state bucket gs://${TF_STATE_BUCKET}"
if gcloud storage buckets describe "gs://${TF_STATE_BUCKET}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  skip "bucket already exists"
else
  # Uniform bucket-level access: IAM only, no per-object ACLs. Versioning keeps
  # every prior state file so a bad apply can be rolled back.
  gcloud storage buckets create "gs://${TF_STATE_BUCKET}" \
    --project "${PROJECT_ID}" \
    --location "${REGION}" \
    --uniform-bucket-level-access \
    --public-access-prevention
  ok "bucket created"
fi
gcloud storage buckets update "gs://${TF_STATE_BUCKET}" --versioning >/dev/null
ok "versioning on"

# ---- 4. deployer service account --------------------------------------------
log "Deployer service account ${DEPLOYER_SA}"
if gcloud iam service-accounts describe "${DEPLOYER_SA}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  skip "service account already exists"
else
  gcloud iam service-accounts create "${DEPLOYER_SA_NAME}" \
    --project "${PROJECT_ID}" \
    --display-name "Supermortgage deployer (GitHub Actions via Workload Identity Federation)"
  ok "service account created"
fi

# These roles are broad ON PURPOSE for the nonprod bootstrap: Terraform must
# create every kind of resource in the project on the first run. Narrow them
# once the environment is stable (see docs/DEPLOY.md, "path to prod").
DEPLOYER_ROLES=(
  roles/editor
  roles/iam.serviceAccountAdmin
  roles/iam.serviceAccountUser
  roles/resourcemanager.projectIamAdmin
  roles/secretmanager.admin
  roles/cloudkms.admin
  roles/run.admin
  roles/compute.loadBalancerAdmin
  roles/compute.securityAdmin
  roles/serviceusage.serviceUsageAdmin
  roles/storage.admin
)
log "Granting project roles to ${DEPLOYER_SA}"
EXISTING_ROLES="$(gcloud projects get-iam-policy "${PROJECT_ID}" \
  --flatten='bindings[].members' \
  --filter="bindings.members:serviceAccount:${DEPLOYER_SA}" \
  --format='value(bindings.role)')"
for role in "${DEPLOYER_ROLES[@]}"; do
  if grep -qx "${role}" <<<"${EXISTING_ROLES}"; then
    skip "${role} already bound"
  else
    gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
      --member "serviceAccount:${DEPLOYER_SA}" \
      --role "${role}" \
      --condition=None \
      --quiet >/dev/null
    ok "${role}"
  fi
done

# ---- 5. Workload Identity Federation ----------------------------------------
log "Workload Identity pool '${WIF_POOL}'"
if gcloud iam workload-identity-pools describe "${WIF_POOL}" \
     --project "${PROJECT_ID}" --location global >/dev/null 2>&1; then
  skip "pool already exists"
else
  gcloud iam workload-identity-pools create "${WIF_POOL}" \
    --project "${PROJECT_ID}" \
    --location global \
    --display-name "GitHub Actions"
  ok "pool created"
fi

log "OIDC provider '${WIF_PROVIDER}' for github.com"
# The attribute condition is what stops any other GitHub repository from
# exchanging its token for this pool: only ${GITHUB_REPO} is accepted.
if gcloud iam workload-identity-pools providers describe "${WIF_PROVIDER}" \
     --project "${PROJECT_ID}" --location global \
     --workload-identity-pool "${WIF_POOL}" >/dev/null 2>&1; then
  skip "provider already exists (updating its attribute condition to ${GITHUB_REPO})"
  gcloud iam workload-identity-pools providers update-oidc "${WIF_PROVIDER}" \
    --project "${PROJECT_ID}" \
    --location global \
    --workload-identity-pool "${WIF_POOL}" \
    --attribute-condition "assertion.repository == \"${GITHUB_REPO}\"" >/dev/null
else
  gcloud iam workload-identity-pools providers create-oidc "${WIF_PROVIDER}" \
    --project "${PROJECT_ID}" \
    --location global \
    --workload-identity-pool "${WIF_POOL}" \
    --display-name "GitHub" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition "assertion.repository == \"${GITHUB_REPO}\""
  ok "provider created"
fi

WIF_PROVIDER_NAME="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}/providers/${WIF_PROVIDER}"
WIF_PRINCIPAL="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}/attribute.repository/${GITHUB_REPO}"

log "Allowing ${GITHUB_REPO} workflows to act as ${DEPLOYER_SA}"
if gcloud iam service-accounts get-iam-policy "${DEPLOYER_SA}" --project "${PROJECT_ID}" \
     --flatten='bindings[].members' \
     --filter="bindings.role:roles/iam.workloadIdentityUser AND bindings.members:${WIF_PRINCIPAL}" \
     --format='value(bindings.members)' | grep -q .; then
  skip "workloadIdentityUser binding already present"
else
  gcloud iam service-accounts add-iam-policy-binding "${DEPLOYER_SA}" \
    --project "${PROJECT_ID}" \
    --role roles/iam.workloadIdentityUser \
    --member "${WIF_PRINCIPAL}" \
    --quiet >/dev/null
  ok "binding added"
fi

# ---- 6. what to do next -----------------------------------------------------
cat <<EOM

=============================================================================
 Bootstrap finished for project ${PROJECT_ID}.
=============================================================================

 Set these five GitHub repository VARIABLES (Settings -> Secrets and variables
 -> Actions -> Variables tab -> "New repository variable"). They are variables,
 not secrets: none of them is sensitive, and Workload Identity Federation means
 there is no key file to store.

   https://github.com/${GITHUB_REPO}/settings/variables/actions

   Name               Value
   -----------------  ------------------------------------------------------------
   GCP_PROJECT_ID     ${PROJECT_ID}
   GCP_REGION         ${REGION}
   GCP_WIF_PROVIDER   ${WIF_PROVIDER_NAME}
   GCP_DEPLOYER_SA    ${DEPLOYER_SA}
   TF_STATE_BUCKET    ${TF_STATE_BUCKET}

 Next step: push to the deploy branch, or open
   https://github.com/${GITHUB_REPO}/actions/workflows/deploy.yml
 and click "Run workflow". The workflow runs Terraform, builds the image,
 migrates the database and deploys. Its summary prints the two DNS A records
 to enter at GoDaddy.

EOM
