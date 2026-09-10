provider "google" {
  project = var.project_id
  region  = var.region

  # Every resource that supports labels gets these so cost and cleanup can be
  # scoped per environment.
  default_labels = local.labels
}

provider "google-beta" {
  project        = var.project_id
  region         = var.region
  default_labels = local.labels
}

locals {
  labels = {
    app         = "supermortgage"
    environment = var.environment
    managed_by  = "terraform"
  }
}
