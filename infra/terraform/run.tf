# One image, three modes. The service and both jobs share the runtime service
# account, the two secrets and the Cloud SQL socket volume; only the argument
# (serve / migrate / sweep) differs.

locals {
  # Environment the container reads. PORT is injected by Cloud Run itself and
  # must not be set here (Cloud Run rejects a user-supplied PORT).
  common_env = {
    HOST         = "0.0.0.0"
    INTEGRATIONS = "fake" # nonprod: every vendor integration is a test double
    LOG_FORMAT   = "json"
    ENVIRONMENT  = var.environment # optional in the runtime; labels log lines
  }
  # Borrower API settings (src/runtime/borrower/routes.ts): the borrower app is served
  # at /app on the same hostname, so WebAuthn's relying party and allowed origin are that host.
  borrower_api_env = {
    BORROWER_RP_ID   = var.api_hostname
    BORROWER_ORIGINS = "https://${var.api_hostname}"
    BORROWER_APP_URL = "https://${var.api_hostname}/app"
    # 32.14 DELTA-15: the Phase I partner party (empty → the newest servicer party)
    BORROWER_DEFAULT_PARTNER_ID = var.borrower_default_partner_id
    # 32.14 DELTA-12: the OAuth redirect Google sends the code back to (the app's callback page, an allowed origin)
    GOOGLE_OAUTH_REDIRECT = "https://${var.api_hostname}/app/auth/google/callback"
  }
  cloudsql_volume = "cloudsql"
  cloudsql_mount  = "/cloudsql"
}

# ---------------------------------------------------------------------------
# HTTP service: `serve`
# ---------------------------------------------------------------------------
resource "google_cloud_run_v2_service" "api" {
  name     = "supermortgage-api"
  location = var.region

  # Only traffic that arrives via the external Application Load Balancer (and
  # therefore through Cloud Armor) reaches the service; the run.app URL is
  # not reachable from the internet.
  ingress = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  # Nonprod: allow `terraform destroy` to remove the service.
  deletion_protection = false

  template {
    service_account = google_service_account.runtime.email

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    containers {
      image = var.image
      args  = ["serve"]

      dynamic "env" {
        for_each = local.common_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.borrower_api_env
        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "API_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.api_token.secret_id
            version = "latest"
          }
        }
      }

      # 32.14 DELTA-12: Sign in with Google — values set by hand in Secret Manager
      # (docs/DEPLOY.md "Sign in with Google"); the placeholder version reads as
      # unset and the FAKE provider stays in place.
      env {
        name = "GOOGLE_OAUTH_CLIENT_ID"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.google_oauth_client_id.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "GOOGLE_OAUTH_CLIENT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.google_oauth_client_secret.secret_id
            version = "latest"
          }
        }
      }

      # Talk: the conversational entry's model (src/runtime/borrower/talk.ts) — a real
      # version of the secret turns it on; the placeholder leaves that one route at 503.
      env {
        name = "ANTHROPIC_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.anthropic_api_key.secret_id
            version = "latest"
          }
        }
      }

      # 32.17: the video agent — a real version of the Tavus key turns the live vendor on
      # (the FAKE stands in on the placeholder); the callback secret is the secret path segment
      # of the vendor's callback URL; VIDEO_API_URL is the public origin the vendor reaches
      # the custom-LLM endpoint and the callback on (the load balancer's hostname).
      env {
        name = "TAVUS_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.tavus_api_key.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "VIDEO_CALLBACK_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.video_callback_secret.secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "VIDEO_API_URL"
        value = "https://${var.api_hostname}"
      }
      env {
        name  = "VIDEO_BORROWER_CAMERA"
        value = "on"
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
        # CPU stays allocated between requests so timers/outbox work started
        # by a request finishes promptly and the console answers quickly.
        cpu_idle          = false
        startup_cpu_boost = true
      }

      startup_probe {
        http_get {
          path = "/healthz"
        }
        initial_delay_seconds = 0
        period_seconds        = 5
        timeout_seconds       = 3
        failure_threshold     = 12
      }

      liveness_probe {
        http_get {
          path = "/healthz"
        }
        period_seconds    = 30
        timeout_seconds   = 3
        failure_threshold = 3
      }

      volume_mounts {
        name       = local.cloudsql_volume
        mount_path = local.cloudsql_mount
      }
    }

    volumes {
      name = local.cloudsql_volume
      cloud_sql_instance {
        instances = [google_sql_database_instance.main.connection_name]
      }
    }
  }

  # After the first apply the deploy workflow (`gcloud run deploy`) owns the
  # image; Terraform must not roll it back to the placeholder.
  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  # The revision only becomes ready once the SA can read every secret it mounts.
  depends_on = [
    google_secret_manager_secret_iam_member.runtime_database_url,
    google_secret_manager_secret_iam_member.runtime_api_token,
    google_secret_manager_secret_iam_member.runtime_google_oauth_client_id,
    google_secret_manager_secret_iam_member.runtime_google_oauth_client_secret,
    google_secret_manager_secret_version.database_url,
    google_secret_manager_secret_version.api_token,
    google_secret_manager_secret_version.google_oauth_client_id,
    google_secret_manager_secret_version.google_oauth_client_secret,
    google_project_iam_member.runtime_roles,
  ]
}

# Cloud Run-level access is public so the load balancer's serverless NEG can
# forward traffic without an identity token. This is safe because (1) ingress
# above is restricted to the load balancer, so only traffic that passed Cloud
# Armor arrives, and (2) the application itself requires
# `Authorization: Bearer <API_TOKEN>` on everything except /healthz and /readyz.
resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  project  = google_cloud_run_v2_service.api.project
  location = google_cloud_run_v2_service.api.location
  name     = google_cloud_run_v2_service.api.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ---------------------------------------------------------------------------
# Job: `migrate` — applied before every deploy by the workflow
# ---------------------------------------------------------------------------
resource "google_cloud_run_v2_job" "migrate" {
  name     = "supermortgage-migrate"
  location = var.region

  deletion_protection = false

  template {
    task_count = 1

    template {
      service_account = google_service_account.runtime.email
      timeout         = "900s"
      max_retries     = 0 # a half-applied migration must be looked at, not retried blindly

      containers {
        image = var.image
        args  = ["migrate"]

        dynamic "env" {
          for_each = local.common_env
          content {
            name  = env.key
            value = env.value
          }
        }

        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.database_url.secret_id
              version = "latest"
            }
          }
        }

        env {
          name = "API_TOKEN"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.api_token.secret_id
              version = "latest"
            }
          }
        }

        resources {
          limits = {
            cpu    = "1"
            memory = "1Gi"
          }
        }

        volume_mounts {
          name       = local.cloudsql_volume
          mount_path = local.cloudsql_mount
        }
      }

      volumes {
        name = local.cloudsql_volume
        cloud_sql_instance {
          instances = [google_sql_database_instance.main.connection_name]
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_secret_manager_secret_iam_member.runtime_database_url,
    google_secret_manager_secret_iam_member.runtime_api_token,
    google_secret_manager_secret_version.database_url,
    google_secret_manager_secret_version.api_token,
    google_project_iam_member.runtime_roles,
  ]
}

# ---------------------------------------------------------------------------
# Job: `sweep` — one pass over due timers and the outbox, run every minute
# ---------------------------------------------------------------------------
resource "google_cloud_run_v2_job" "sweep" {
  name     = "supermortgage-sweep"
  location = var.region

  deletion_protection = false

  template {
    task_count = 1

    template {
      service_account = google_service_account.runtime.email
      timeout         = "300s"
      max_retries     = 1

      containers {
        image = var.image
        args  = ["sweep"]

        dynamic "env" {
          for_each = local.common_env
          content {
            name  = env.key
            value = env.value
          }
        }

        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.database_url.secret_id
              version = "latest"
            }
          }
        }

        env {
          name = "API_TOKEN"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.api_token.secret_id
              version = "latest"
            }
          }
        }

        resources {
          limits = {
            cpu    = "1"
            memory = "1Gi"
          }
        }

        volume_mounts {
          name       = local.cloudsql_volume
          mount_path = local.cloudsql_mount
        }
      }

      volumes {
        name = local.cloudsql_volume
        cloud_sql_instance {
          instances = [google_sql_database_instance.main.connection_name]
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_secret_manager_secret_iam_member.runtime_database_url,
    google_secret_manager_secret_iam_member.runtime_api_token,
    google_secret_manager_secret_version.database_url,
    google_secret_manager_secret_version.api_token,
    google_project_iam_member.runtime_roles,
  ]
}

# ---------------------------------------------------------------------------
# Job: `seed-demo` — board the built-in 100-loan demo transfer batch (idempotent); run on demand
# ---------------------------------------------------------------------------
resource "google_cloud_run_v2_job" "seed_demo" {
  name     = "supermortgage-seed-demo"
  location = var.region

  deletion_protection = false

  template {
    task_count = 1

    template {
      service_account = google_service_account.runtime.email
      timeout         = "900s"
      max_retries     = 0

      containers {
        image = var.image
        args  = ["seed-demo"]

        dynamic "env" {
          for_each = local.common_env
          content {
            name  = env.key
            value = env.value
          }
        }

        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.database_url.secret_id
              version = "latest"
            }
          }
        }

        env {
          name = "API_TOKEN"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.api_token.secret_id
              version = "latest"
            }
          }
        }

        resources {
          limits = {
            cpu    = "1"
            memory = "1Gi"
          }
        }

        volume_mounts {
          name       = local.cloudsql_volume
          mount_path = local.cloudsql_mount
        }
      }

      volumes {
        name = local.cloudsql_volume
        cloud_sql_instance {
          instances = [google_sql_database_instance.main.connection_name]
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_secret_manager_secret_iam_member.runtime_database_url,
    google_secret_manager_secret_iam_member.runtime_api_token,
    google_secret_manager_secret_version.database_url,
    google_secret_manager_secret_version.api_token,
    google_project_iam_member.runtime_roles,
  ]
}

# ---------------------------------------------------------------------------
# HTTP service: the borrower app (apps/borrower — Next.js standalone, basePath /app)
# ---------------------------------------------------------------------------
# Built from Dockerfile.borrower by the deploy workflow's `build-borrower` job. Served on the
# same hostname as the API behind the load balancer; the URL map sends /app/* here. It talks
# to the API over HTTPS through the load balancer (https://<api_hostname>) from a server-side
# proxy route; the browser never holds an API or session bearer.
resource "google_cloud_run_v2_service" "borrower" {
  name     = "supermortgage-borrower"
  location = var.region

  ingress = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  deletion_protection = false

  template {
    service_account = google_service_account.borrower.email

    scaling {
      min_instance_count = var.borrower_min_instances
      max_instance_count = var.borrower_max_instances
    }

    containers {
      image = var.image # placeholder until the workflow deploys the borrower image

      env {
        name  = "API_BASE_URL"
        value = "https://${var.api_hostname}"
      }

      env {
        name  = "ENVIRONMENT"
        value = var.environment
      }

      # The ops API token, for server-side calls only (never forwarded to the browser and never
      # used on /v1/borrower/*, which is session-authenticated). Read from the same secret.
      env {
        name = "API_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.api_token.secret_id
            version = "latest"
          }
        }
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      startup_probe {
        tcp_socket {
          port = 8080
        }
        initial_delay_seconds = 0
        period_seconds        = 5
        timeout_seconds       = 3
        failure_threshold     = 12
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_secret_manager_secret_iam_member.borrower_api_token,
    google_secret_manager_secret_version.api_token,
    google_project_iam_member.borrower_roles,
  ]
}

# Same reasoning as the API service: ingress is load-balancer only, so allUsers at the
# Cloud Run layer just lets the serverless NEG forward traffic; the app is public by design.
resource "google_cloud_run_v2_service_iam_member" "borrower_public_invoker" {
  project  = google_cloud_run_v2_service.borrower.project
  location = google_cloud_run_v2_service.borrower.location
  name     = google_cloud_run_v2_service.borrower.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
