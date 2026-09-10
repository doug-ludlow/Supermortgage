# Cloud SQL for PostgreSQL 16. Reached only through the Cloud Run Cloud SQL
# volume (unix socket under /cloudsql), which is authorised by IAM
# (roles/cloudsql.client on the runtime service account).
resource "google_sql_database_instance" "main" {
  name             = "supermortgage-${var.environment}"
  region           = var.region
  database_version = "POSTGRES_16"

  # Key must exist and be usable by the Cloud SQL service agent first.
  encryption_key_name = google_kms_crypto_key.sql.id

  # Nonprod: refuse accidental `terraform destroy`; flip the variable to false
  # (and apply) when the environment is meant to go away.
  deletion_protection = var.db_deletion_protection

  settings {
    tier              = var.db_tier
    availability_type = "ZONAL" # nonprod; prod moves to REGIONAL
    disk_autoresize   = true
    disk_type         = "PD_SSD"
    edition           = "ENTERPRISE"

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "07:00" # UTC = 03:00 America/New_York, the quietest hour
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 14
        retention_unit   = "COUNT"
      }
    }

    ip_configuration {
      # Public IP with NO authorized networks is the documented Cloud Run +
      # Cloud SQL connector pattern: the only path in is the Cloud SQL Auth
      # proxy/socket, which requires an IAM principal with cloudsql.client.
      # Nothing can open a TCP connection to the instance from the internet.
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY" # plaintext connections are refused even on the socket path
    }

    # Log any statement slower than one second so slow sweeps are visible.
    database_flags {
      name  = "log_min_duration_statement"
      value = "1000"
    }

    maintenance_window {
      day          = 7 # Sunday
      hour         = 8 # UTC
      update_track = "stable"
    }

    insights_config {
      query_insights_enabled  = true
      record_application_tags = false
      record_client_address   = false
    }

    user_labels = local.labels
  }

  depends_on = [
    google_project_service.apis,
    google_kms_crypto_key_iam_member.sql_agent,
  ]
}

resource "google_sql_database" "supermortgage" {
  name     = "supermortgage"
  instance = google_sql_database_instance.main.name
}

# 32 alphanumeric characters: safe to embed in a URL without percent-encoding.
resource "random_password" "db" {
  length  = 32
  special = false
}

resource "google_sql_user" "sm" {
  name     = "sm"
  instance = google_sql_database_instance.main.name
  password = random_password.db.result
}
