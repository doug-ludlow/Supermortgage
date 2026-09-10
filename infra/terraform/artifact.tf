# Docker repository the deploy workflow pushes the application image to.
resource "google_artifact_registry_repository" "supermortgage" {
  location      = var.region
  repository_id = "supermortgage"
  description   = "Supermortgage container images"
  format        = "DOCKER"

  # Keep the registry from growing without bound: untagged layers go after
  # 30 days, the newest 20 tagged images are always kept.
  cleanup_policies {
    id     = "delete-untagged"
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "2592000s"
    }
  }
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 20
    }
  }

  labels = local.labels

  depends_on = [google_project_service.apis]
}
