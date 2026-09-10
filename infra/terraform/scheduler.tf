# Cloud Scheduler starts the sweep job once a minute via the Cloud Run Admin
# API, authenticating as the scheduler service account (OAuth access token),
# which only holds run.invoker on that single job.
resource "google_cloud_scheduler_job" "sweep" {
  name        = "supermortgage-sweep-every-minute"
  region      = var.region
  description = "Runs the supermortgage-sweep Cloud Run job (due timers + integration outbox)."
  schedule    = "* * * * *"
  time_zone   = "America/New_York" # the spec's wall-clock zone

  attempt_deadline = "180s"

  retry_config {
    retry_count = 1
  }

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.sweep.name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }

  depends_on = [
    google_project_service.apis,
    google_cloud_run_v2_job_iam_member.scheduler_runs_sweep,
  ]
}
