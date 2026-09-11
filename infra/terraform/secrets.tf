# Runtime secrets. Cloud Run reads them through Secret Manager at instance
# start; nothing secret lives in the service definition or in the image.

resource "google_secret_manager_secret" "database_url" {
  secret_id = "supermortgage-database-url"

  replication {
    auto {}
  }

  labels = local.labels

  depends_on = [google_project_service.apis]
}

# DATABASE_URL in the socket form the pg driver understands:
#   postgresql://sm:<password>@/supermortgage?host=/cloudsql/<project>:<region>:<instance>
resource "google_secret_manager_secret_version" "database_url" {
  secret      = google_secret_manager_secret.database_url.id
  secret_data = "postgresql://${google_sql_user.sm.name}:${random_password.db.result}@/${google_sql_database.supermortgage.name}?host=/cloudsql/${google_sql_database_instance.main.connection_name}"
}

# 48 alphanumeric characters; used verbatim as `Authorization: Bearer <token>`.
resource "random_password" "api_token" {
  length  = 48
  special = false
}

locals {
  api_token = var.api_token != "" ? var.api_token : random_password.api_token.result
}

resource "google_secret_manager_secret" "api_token" {
  secret_id = "supermortgage-api-token"

  replication {
    auto {}
  }

  labels = local.labels

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "api_token" {
  secret      = google_secret_manager_secret.api_token.id
  secret_data = local.api_token
}

# 32.14 DELTA-12 — Sign in with Google. The OAuth client (docs/DEPLOY.md "Sign in
# with Google") is created by hand in the Google Cloud console; its id and secret
# are set by hand as new versions of these two secrets. Terraform writes a
# placeholder first version so the Cloud Run revision can start before the client
# exists (a secret without any version fails the revision); the runtime treats the
# placeholder as "not configured" and keeps the FAKE provider.
resource "google_secret_manager_secret" "google_oauth_client_id" {
  secret_id = "supermortgage-google-oauth-client-id"

  replication {
    auto {}
  }

  labels = local.labels

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "google_oauth_client_id" {
  secret      = google_secret_manager_secret.google_oauth_client_id.id
  secret_data = "unset"

  lifecycle {
    ignore_changes = [secret_data]
  }
}

resource "google_secret_manager_secret" "google_oauth_client_secret" {
  secret_id = "supermortgage-google-oauth-client-secret"

  replication {
    auto {}
  }

  labels = local.labels

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "google_oauth_client_secret" {
  secret      = google_secret_manager_secret.google_oauth_client_secret.id
  secret_data = "unset"

  lifecycle {
    ignore_changes = [secret_data]
  }
}

# Per-secret access for the API runtime only (the borrower app never sees the client secret).
resource "google_secret_manager_secret_iam_member" "runtime_google_oauth_client_id" {
  secret_id = google_secret_manager_secret.google_oauth_client_id.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_secret_manager_secret_iam_member" "runtime_google_oauth_client_secret" {
  secret_id = google_secret_manager_secret.google_oauth_client_secret.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}
