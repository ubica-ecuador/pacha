# The stack's two images, tagged the way compose.yaml runs them.
# Platforms and push are added by the release workflow (P3).

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
  tags    = ["${REGISTRY}/geostack-grafana:${STACK_VERSION}"]
  labels  = { "org.opencontainers.image.version" = STACK_VERSION }
}

target "titiler" {
  context = "images/titiler"
  tags    = ["${REGISTRY}/geostack-titiler:${STACK_VERSION}"]
  labels  = { "org.opencontainers.image.version" = STACK_VERSION }
}
