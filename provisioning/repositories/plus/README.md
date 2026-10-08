Empty on purpose: compose.plus.yaml mounts plus/repositories here. With no
definition in it, start.sh deletes the `plus` repository and its dashboards.
The folder has to exist, since provisioning/ is mounted read-only and Docker
cannot create a mountpoint inside it.
