output "load_balancer_ip" {
  description = "Static IPv4 address of the external Application Load Balancer. Point the api/console A records here."
  value       = google_compute_global_address.lb.address
}

output "api_url" {
  description = "Public API base URL once DNS and the managed certificate are in place."
  value       = "https://${var.api_hostname}"
}

output "console_url" {
  description = "Public ops console URL once DNS and the managed certificate are in place."
  value       = "https://${var.console_hostname}"
}

output "borrower_url" {
  description = "Public borrower app URL (Next.js basePath /app on the API/console hostname) once DNS and the certificate are in place."
  value       = "https://${var.api_hostname}/app"
}

output "borrower_cloud_run_service_url" {
  description = "The borrower service's run.app URL. Not reachable from the internet (ingress is load-balancer only)."
  value       = google_cloud_run_v2_service.borrower.uri
}

output "cloud_run_service_url" {
  description = "The service's run.app URL. Not reachable from the internet (ingress is load-balancer only); shown for `gcloud` reference."
  value       = google_cloud_run_v2_service.api.uri
}

output "sql_connection_name" {
  description = "Cloud SQL instance connection name (<project>:<region>:<instance>), the socket directory under /cloudsql."
  value       = google_sql_database_instance.main.connection_name
}

output "artifact_registry_repo" {
  description = "Docker repository the deploy workflow pushes to."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.supermortgage.repository_id}"
}

output "runtime_service_account" {
  description = "Service account the Cloud Run service and jobs run as."
  value       = google_service_account.runtime.email
}

output "scheduler_service_account" {
  description = "Service account Cloud Scheduler uses to start the sweep job."
  value       = google_service_account.scheduler.email
}

output "secret_names" {
  description = "Secret Manager secret IDs. Read the API token with: gcloud secrets versions access latest --secret supermortgage-api-token"
  value = {
    database_url = google_secret_manager_secret.database_url.secret_id
    api_token    = google_secret_manager_secret.api_token.secret_id
  }
}

output "migrate_job" {
  description = "Cloud Run job that applies db/migrations before each deploy."
  value       = google_cloud_run_v2_job.migrate.name
}

output "sweep_job" {
  description = "Cloud Run job Cloud Scheduler executes every minute."
  value       = google_cloud_run_v2_job.sweep.name
}

output "godaddy_dns_records" {
  description = <<-EOT
    Enter these A records in GoDaddy DNS for supermortgage.com (the value of
    var.domain): My Products -> the domain -> DNS -> Add New Record. Only these
    hostnames move to Google Cloud; the apex (@) record and anything else on the
    domain stay exactly where they are today. The managed certificate provisions
    automatically once every name resolves to this IP (allow up to 60 minutes).
  EOT
  value = [
    for h in local.hostnames : {
      type  = "A"
      name  = trimsuffix(h, ".${var.domain}")
      value = google_compute_global_address.lb.address
      ttl   = 600
    }
  ]
}

output "seed_demo_job" {
  description = "Cloud Run job that boards the 100-loan demo transfer batch (idempotent): gcloud run jobs execute supermortgage-seed-demo --region <region> --wait"
  value       = google_cloud_run_v2_job.seed_demo.name
}
