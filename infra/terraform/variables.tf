variable "project_id" {
  description = "Google Cloud project ID that hosts this environment (e.g. supermortgage-nonprod)."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run, Cloud SQL, Artifact Registry and the serverless NEG."
  type        = string
  default     = "us-central1"
}

variable "environment" {
  description = "Environment name; used as a label and as the state prefix. One workspace/state per environment."
  type        = string
  default     = "nonprod"
}

variable "domain" {
  description = "Registered apex domain. The apex itself is NOT touched by this configuration."
  type        = string
  default     = "supermortgage.com"
}

variable "api_hostname" {
  description = "Hostname the API answers on behind the load balancer. May equal console_hostname (one name for both)."
  type        = string
  default     = "demo.supermortgage.com"
}

variable "console_hostname" {
  description = "Hostname the ops console answers on behind the load balancer (same backend as the API). May equal api_hostname."
  type        = string
  default     = "demo.supermortgage.com"
}

variable "image" {
  description = "Initial container image. The placeholder lets the first apply succeed before any application image exists; afterwards the deploy workflow owns the image and Terraform ignores it."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "db_tier" {
  description = "Cloud SQL machine tier."
  type        = string
  default     = "db-custom-1-3840"
}

variable "db_deletion_protection" {
  description = "Refuse to destroy the Cloud SQL instance. Must be set to false (and applied) before `terraform destroy` can succeed."
  type        = bool
  default     = true
}

variable "min_instances" {
  description = "Minimum Cloud Run instances for the API service (1 keeps a warm instance so the console answers promptly)."
  type        = number
  default     = 1
}

variable "max_instances" {
  description = "Maximum Cloud Run instances for the API service."
  type        = number
  default     = 10
}

variable "api_token" {
  description = "Bearer token the runtime requires on every non-health route. Leave empty to have Terraform generate one and store it in Secret Manager."
  type        = string
  default     = ""
  sensitive   = true
}

variable "borrower_min_instances" {
  description = "Minimum Cloud Run instances for the borrower app (supermortgage-borrower)."
  type        = number
  default     = 1
}

variable "borrower_max_instances" {
  description = "Maximum Cloud Run instances for the borrower app."
  type        = number
  default     = 10
}
