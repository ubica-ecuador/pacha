Empty on purpose: compose.plus.yaml mounts plus/provisioning-plugins here. The
folder has to exist, since provisioning/ is mounted read-only and Docker cannot
create a mountpoint inside it.
