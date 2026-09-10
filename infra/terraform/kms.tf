# Customer-managed encryption key for Cloud SQL (CMEK). Borrower data at rest
# is encrypted with a key the project controls and can revoke, not only with
# Google-managed keys.
resource "google_kms_key_ring" "sql" {
  name     = "supermortgage-${var.environment}"
  location = var.region

  depends_on = [google_project_service.apis]
}

resource "google_kms_crypto_key" "sql" {
  name     = "supermortgage-sql"
  key_ring = google_kms_key_ring.sql.id
  purpose  = "ENCRYPT_DECRYPT"

  # 90-day automatic rotation; old versions stay available so existing data
  # remains readable.
  rotation_period = "7776000s"

  # Note: destroying this resource disables every key version, which makes any
  # remaining Cloud SQL data unreadable. Destroy the instance first (it is
  # ordered that way by depends_on) and only then the key.

  labels = local.labels
}

# The Cloud SQL service agent (service-<number>@gcp-sa-cloud-sql.iam.gserviceaccount.com)
# must exist and be allowed to use the key before an instance can be created
# with encryption_key_name.
resource "google_project_service_identity" "sqladmin" {
  provider = google-beta

  project = var.project_id
  service = "sqladmin.googleapis.com"

  depends_on = [google_project_service.apis]
}

resource "google_kms_crypto_key_iam_member" "sql_agent" {
  crypto_key_id = google_kms_crypto_key.sql.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_project_service_identity.sqladmin.email}"
}
