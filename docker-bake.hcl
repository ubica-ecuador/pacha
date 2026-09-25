# The stack's two images, tagged the way compose.yaml runs them.
# Platforms and push are added by the release workflow (P3).
# Note: bake also loads compose.yaml from this directory; keep its targets parseable.

variable "STACK_VERSION" {
  default = "dev"
}

variable "REGISTRY" {
  default = "ghcr.io/ubica-ecuador"
}

group "default" {
  targets = ["grafana", "titiler"]
}

target "grafana" {
  context = "images/grafana"
  tags    = ["${REGISTRY}/pacha-grafana:${STACK_VERSION}"]
  labels  = { "org.opencontainers.image.version" = STACK_VERSION }
}

target "titiler" {
  context = "images/titiler"
  tags    = ["${REGISTRY}/pacha-titiler:${STACK_VERSION}"]
  labels  = { "org.opencontainers.image.version" = STACK_VERSION }
}
