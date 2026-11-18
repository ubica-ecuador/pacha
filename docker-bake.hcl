# The stack's images, tagged the way compose.yaml runs them.
# Platforms and push are added by .github/workflows/images.yml.
# Note: bake also loads compose.yaml from this directory; keep its targets parseable.

variable "STACK_VERSION" {
  default = "dev"
}

variable "REGISTRY" {
  default = "ghcr.io/ubica-ecuador"
}

# Links each package on GHCR to this repository.
variable "SOURCE" {
  default = "https://github.com/ubica-ecuador/pacha"
}

group "default" {
  targets = ["grafana", "titiler", "recorder"]
}

target "grafana" {
  context = "images/grafana"
  tags    = ["${REGISTRY}/pacha-grafana:${STACK_VERSION}"]
  labels  = { "org.opencontainers.image.version" = STACK_VERSION, "org.opencontainers.image.source" = SOURCE }
  # Published images always bake the pinned release; KEPLER_PANEL_CHANNEL is
  # for `docker compose build` only.
  args    = { KEPLER_PANEL_CHANNEL = "release" }
}

target "titiler" {
  context = "images/titiler"
  tags    = ["${REGISTRY}/pacha-titiler:${STACK_VERSION}"]
  labels  = { "org.opencontainers.image.version" = STACK_VERSION, "org.opencontainers.image.source" = SOURCE }
}

target "recorder" {
  context  = "images/recorder"
  # The feeds it records, baked in: recorder/feeds/.
  contexts = { feeds = "recorder/feeds" }
  tags     = ["${REGISTRY}/pacha-recorder:${STACK_VERSION}"]
  labels   = { "org.opencontainers.image.version" = STACK_VERSION, "org.opencontainers.image.source" = SOURCE }
}
