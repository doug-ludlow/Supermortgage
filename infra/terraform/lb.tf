# Global external Application Load Balancer in front of the Cloud Run service.
# It terminates TLS with a Google-managed certificate, applies Cloud Armor,
# and is the only ingress path the service accepts.

resource "google_compute_global_address" "lb" {
  name       = "supermortgage-lb-ip"
  ip_version = "IPV4"

  depends_on = [google_project_service.apis]
}

resource "google_compute_region_network_endpoint_group" "api" {
  name                  = "supermortgage-api-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = google_cloud_run_v2_service.api.name
  }
}

# Cloud Armor: default allow, a per-IP rate limit, and Google's preconfigured
# SQLi/XSS signatures in preview (logged, not enforced) until the false-positive
# rate on real traffic is understood. Prod takes them out of preview.
resource "google_compute_security_policy" "armor" {
  name        = "supermortgage-armor"
  description = "Edge policy for the Supermortgage API/console"
  type        = "CLOUD_ARMOR"

  # Preconfigured WAF rules, preview only.
  rule {
    priority    = 100
    action      = "deny(403)"
    preview     = true
    description = "Preconfigured SQL injection signatures (preview)"
    match {
      expr {
        expression = "evaluatePreconfiguredWaf('sqli-v33-stable', {'sensitivity': 1})"
      }
    }
  }

  rule {
    priority    = 101
    action      = "deny(403)"
    preview     = true
    description = "Preconfigured cross-site scripting signatures (preview)"
    match {
      expr {
        expression = "evaluatePreconfiguredWaf('xss-v33-stable', {'sensitivity': 1})"
      }
    }
  }

  # 300 requests per minute per client IP; excess is throttled with 429 for
  # the ban-free duration of the window.
  rule {
    priority    = 1000
    action      = "throttle"
    description = "Rate limit: 300 requests/minute per source IP"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"
      rate_limit_threshold {
        count        = 300
        interval_sec = 60
      }
    }
  }

  # Default rule (lowest priority): allow. Authentication is the application's
  # bearer token, not the edge.
  rule {
    priority    = 2147483647
    action      = "allow"
    description = "Default allow"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_compute_backend_service" "api" {
  name                  = "supermortgage-api-backend"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  security_policy       = google_compute_security_policy.armor.id

  backend {
    group = google_compute_region_network_endpoint_group.api.id
  }

  # Every request is logged at the edge, including Cloud Armor verdicts.
  log_config {
    enable      = true
    sample_rate = 1.0
  }
}

resource "google_compute_url_map" "https" {
  name            = "supermortgage-https"
  default_service = google_compute_backend_service.api.id

  # The API and console hostnames (one name, or two) route to the one service.
  host_rule {
    hosts        = local.hostnames
    path_matcher = "supermortgage"
  }

  path_matcher {
    name            = "supermortgage"
    default_service = google_compute_backend_service.api.id
  }
}

# Google-managed certificate for the hostnames. The apex domain is NOT
# included: it keeps pointing wherever it does today, and adding it here
# would block certificate issuance until the apex A record moved too.
# The name carries a hash of the hostnames: a managed certificate's domains are
# immutable, so a hostname change creates a new certificate (new name) before
# the old one is detached.
locals {
  hostnames = distinct([var.api_hostname, var.console_hostname])
}

resource "google_compute_managed_ssl_certificate" "api" {
  name = "supermortgage-cert-${substr(md5(join(",", local.hostnames)), 0, 8)}"

  managed {
    domains = local.hostnames
  }

  # Managed certificates are immutable; rotating hostnames creates the new one
  # before detaching the old.
  lifecycle {
    create_before_destroy = true
  }
}

resource "google_compute_target_https_proxy" "api" {
  name             = "supermortgage-https-proxy"
  url_map          = google_compute_url_map.https.id
  ssl_certificates = [google_compute_managed_ssl_certificate.api.id]
}

resource "google_compute_global_forwarding_rule" "https" {
  name                  = "supermortgage-https-443"
  target                = google_compute_target_https_proxy.api.id
  ip_address            = google_compute_global_address.lb.id
  port_range            = "443"
  ip_protocol           = "TCP"
  load_balancing_scheme = "EXTERNAL_MANAGED"
}

# Port 80 only redirects to HTTPS; nothing is served in clear text.
resource "google_compute_url_map" "http_redirect" {
  name = "supermortgage-http-redirect"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "redirect" {
  name    = "supermortgage-http-proxy"
  url_map = google_compute_url_map.http_redirect.id
}

resource "google_compute_global_forwarding_rule" "http" {
  name                  = "supermortgage-http-80"
  target                = google_compute_target_http_proxy.redirect.id
  ip_address            = google_compute_global_address.lb.id
  port_range            = "80"
  ip_protocol           = "TCP"
  load_balancing_scheme = "EXTERNAL_MANAGED"
}
