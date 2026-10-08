#!/bin/sh
# Lets Grafana (uid 472 in its container) write the dashboard folders that
# compose mounts read-write in dev, so a save in Grafana lands in this working
# tree. Default ACLs too, so files git or Grafana create later inherit it.
# Once per clone, on Linux. Public instances sync with GitHub and need none.
set -eu
cd "$(dirname "$0")/.."
for dir in dashboards plus/dashboards; do
  setfacl -R -m u:472:rwX -m d:u:472:rwX -m "d:u:$(id -u):rwX" "$dir"
done
echo "Grafana can now write dashboards/ and plus/dashboards/."
