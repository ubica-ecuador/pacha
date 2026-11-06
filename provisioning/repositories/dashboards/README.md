Empty on purpose: compose.dashboards.yaml mounts the dashboards repo's
grafana/repositories here. With no definition in it, start.sh deletes the
`dashboards` repository and its dashboards. The folder has to exist, since
provisioning/ is mounted read-only and Docker cannot create a mountpoint inside it.
