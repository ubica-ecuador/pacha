#!/bin/sh
# Grafana's entrypoint in Pacha: applies the Git Sync repositories defined
# beside this script, then runs the image's own /run.sh.
#
# Each folder here is one Repository, named after the folder, with one
# definition per repository type (local.yaml, github.yaml); PACHA_REPO_TYPE
# picks which. ${VARIABLES} in a definition come from the environment, and an
# empty one is an error. A folder with no definition for that type is a
# repository that must not exist, so it is deleted with its dashboards: plus/
# is empty unless compose.plus.yaml mounts plus/repositories/ over it.
#
# The healthcheck asks for MARKER as well as /api/health, so `docker compose
# up --wait` fails when the repositories were not applied. Why goes to
# Grafana's log, prefixed "pacha-repositories:".
# See docs/superpowers/specs/2026-10-07-dashboards-git-sync-design.md.
set -u

HERE=/etc/grafana/provisioning/repositories
GRAFANA=http://localhost:3000
REPOS=/apis/provisioning.grafana.app/v0alpha1/namespaces/default/repositories
MARKER=/tmp/pacha-repositories-applied
# Folders the classic file providers left behind, still owned by them, which
# Git Sync refuses to adopt. A one-off migration: drop it once every
# environment has run it.
LEGACY_FOLDERS='start-here gallery plus'

log() { echo "pacha-repositories: $*"; }

# grafana METHOD PATH [curl args...]: prints the body; fails on HTTP >= 400.
grafana() {
  method=$1 path=$2
  shift 2
  curl -sS --fail-with-body -u "$GF_SECURITY_ADMIN_USER:$GF_SECURITY_ADMIN_PASSWORD" \
    -X "$method" "$GRAFANA$path" "$@"
}

# render FILE: FILE with every ${NAME} replaced by its environment value.
render() {
  awk '{
    while (match($0, /\$\{[A-Z0-9_]+\}/)) {
      name = substr($0, RSTART + 2, RLENGTH - 3)
      if (ENVIRON[name] == "") {
        print "pacha-repositories: " name " is not set" > "/dev/stderr"
        exit 1
      }
      $0 = substr($0, 1, RSTART - 1) ENVIRON[name] substr($0, RSTART + RLENGTH)
    }
    print
  }' "$1"
}

migrate_legacy_folders() {
  for uid in $LEGACY_FOLDERS; do
    folder=$(grafana GET "/apis/folder.grafana.app/v1beta1/namespaces/default/folders/$uid" 2>/dev/null) || continue
    printf '%s' "$folder" | grep -q '"grafana.app/managedBy": *"classic-file-provisioning"' || continue
    # Grafana deletes the classic dashboards itself at start, maybe after
    # /api/health is already up: give it a moment before calling the folder busy.
    tries=0
    while :; do
      inside=$(grafana GET "/api/search?folderUIDs=$uid&limit=1") || { log "listing folder $uid failed: $inside"; return 1; }
      [ "$inside" = "[]" ] && break
      tries=$((tries + 1))
      if [ "$tries" -ge 10 ]; then
        log "folder $uid is left from the classic providers and still holds dashboards; move them out or delete them, then restart Grafana"
        return 1
      fi
      sleep 3
    done
    out=$(grafana DELETE "/api/folders/$uid") || { log "deleting the classic folder $uid failed: $out"; return 1; }
    log "deleted the empty classic folder $uid"
  done
}

apply_repositories() {
  for dir in "$HERE"/*/; do
    name=$(basename "$dir")
    definition="$dir$PACHA_REPO_TYPE.yaml"
    if [ -f "$definition" ]; then
      body=$(render "$definition") || return 1
      out=$(printf '%s\n' "$body" | grafana PUT "$REPOS/$name" -H 'Content-Type: application/yaml' --data-binary @-) || {
        log "applying $name failed: $out"
        return 1
      }
      log "applied $name ($PACHA_REPO_TYPE)"
    else
      status=$(curl -s -o /dev/null -w '%{http_code}' -u "$GF_SECURITY_ADMIN_USER:$GF_SECURITY_ADMIN_PASSWORD" \
        -X DELETE "$GRAFANA$REPOS/$name")
      case $status in
        200 | 202) log "deleted $name: it has no $PACHA_REPO_TYPE definition" ;;
        404) ;;
        *) log "deleting $name failed: HTTP $status"; return 1 ;;
      esac
    fi
  done
}

# A local repository needs Grafana (uid 472) to write the mounted folder.
warn_unwritable() {
  [ "$PACHA_REPO_TYPE" = local ] || return 0
  for path in /var/lib/pacha/dashboards /var/lib/pacha/plus-dashboards; do
    [ -d "$path" ] || continue
    if touch "$path/.pacha-write-test" 2>/dev/null; then
      rm -f "$path/.pacha-write-test"
    else
      log "WARNING: Grafana cannot write $path, so saves will fail; run scripts/dev-acl.sh on the host"
    fi
  done
}

main() {
  rm -f "$MARKER"
  case $PACHA_REPO_TYPE in
    local | github) ;;
    *) log "PACHA_REPO_TYPE must be local or github, not '$PACHA_REPO_TYPE'"; return 1 ;;
  esac
  until curl -fs -o /dev/null "$GRAFANA/api/health"; do sleep 2; done
  warn_unwritable
  attempt=1
  until migrate_legacy_folders && apply_repositories; do
    if [ "$attempt" -ge 5 ]; then
      log "repositories NOT applied; the healthcheck stays red"
      return 1
    fi
    attempt=$((attempt + 1))
    sleep 5
  done
  touch "$MARKER"
  log "repositories applied"
}

main &
exec /run.sh "$@"
