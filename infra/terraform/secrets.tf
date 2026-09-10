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
