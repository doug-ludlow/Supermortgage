# Identity the containers run as. Deliberately minimal: it can open the Cloud
# SQL socket, write logs/metrics, and read exactly its two secrets.
resource "google_service_account" "runtime" {
  account_id   = "supermortgage-runtime"
  display_name = "Supermortgage runtime (Cloud Run service and jobs)"

  depends_on = [google_project_service.apis]
}

resource "google_project_iam_member" "runtime_roles" {
  for_each = toset([
    "roles/cloudsql.client",         # open the /cloudsql socket
    "roles/logging.logWriter",       # structured logs
    "roles/monitoring.metricWriter", # custom metrics
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

# Per-secret access rather than project-wide secretmanager.secretAccessor so
# a future secret is not readable by default.
resource "google_secret_manager_secret_iam_member" "runtime_database_url" {
  secret_id = google_secret_manager_secret.database_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_secret_manager_secret_iam_member" "runtime_api_token" {
  secret_id = google_secret_manager_secret.api_token.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

# Identity the borrower app (apps/borrower, Dockerfile.borrower) runs as. It writes
# logs and reads exactly one secret: the API token, which its server-side proxy holds
# and never sends to the browser (the borrower routes themselves are session-authenticated).
resource "google_service_account" "borrower" {
  account_id   = "supermortgage-borrower"
  display_name = "Supermortgage borrower app (Cloud Run service)"

  depends_on = [google_project_service.apis]
}

resource "google_project_iam_member" "borrower_roles" {
  for_each = toset([
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.borrower.email}"
}

resource "google_secret_manager_secret_iam_member" "borrower_api_token" {
  secret_id = google_secret_manager_secret.api_token.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.borrower.email}"
}

# Identity the servicing partner portal (apps/partner, Dockerfile.partner) runs as. It writes
# logs and reads no secret: its cookie proxy forwards the partner session as the bearer and
# nothing else (the partner routes are session-authenticated; the API token opens nothing on
# /v1/partner/*, 36.1-T7), so no Secret Manager grant exists for it.
resource "google_service_account" "partner" {
  account_id   = "supermortgage-partner"
  display_name = "Supermortgage partner portal (Cloud Run service)"

  depends_on = [google_project_service.apis]
}

resource "google_project_iam_member" "partner_roles" {
  for_each = toset([
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.partner.email}"
}

# Identity Cloud Scheduler uses to start the sweep job. It can invoke that
# one job and nothing else.
resource "google_service_account" "scheduler" {
  account_id   = "supermortgage-scheduler"
  display_name = "Supermortgage scheduler (runs the sweep job every minute)"

  depends_on = [google_project_service.apis]
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_runs_sweep" {
  project  = google_cloud_run_v2_job.sweep.project
  location = google_cloud_run_v2_job.sweep.location
  name     = google_cloud_run_v2_job.sweep.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

# NOTE: the deployer service account (supermortgage-deployer) and the GitHub
# Workload Identity Federation pool/provider are created by infra/bootstrap.sh,
# not here: Terraform itself runs from GitHub Actions using them.
