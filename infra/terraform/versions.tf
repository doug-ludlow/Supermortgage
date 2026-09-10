terraform {
  required_version = ">= 1.8"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    # google-beta is used only for google_project_service_identity (kms.tf).
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State lives in a GCS bucket created by infra/bootstrap.sh. The bucket and
  # prefix are supplied at init time so one tree serves every environment:
  #   terraform init -backend-config="bucket=<TF_STATE_BUCKET>" \
  #                  -backend-config="prefix=supermortgage/<environment>"
  backend "gcs" {}
}
