# Dashboards as code with Git Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pacha's dashboards are synced with the repo by Grafana Git Sync, so a save from the UI or from an agent lands in git, on every environment.

**Architecture:** Two Git Sync `Repository` resources (`pacha` over `dashboards/`, `plus` over `plus/dashboards/`), of type `local` in dev and `github` on public instances. Their definitions are YAML files under `provisioning/repositories/`; a script that wraps Grafana's entrypoint `PUT`s them to the provisioning API on every start. The classic dashboard providers go away.

**Tech Stack:** Grafana 13.2.1 (Git Sync, `provisioning.grafana.app/v0alpha1`), Docker Compose 2.27, POSIX `sh`, `curl` and `awk` inside the Grafana image, host ACLs (`setfacl`), Python 3 on the host for one-off edits.

**Spec:** `docs/superpowers/specs/2026-10-07-dashboards-git-sync-design.md`

## Global Constraints

- No new automated tests: the user does not want convention tests. Each task verifies with commands and states the expected output. The existing suites (`npm run test:config`, `npm run test:stack`) run once at the end as regression.
- No new compose service. The bootstrap runs inside the grafana container.
- The Grafana image has no `envsubst`, `jq` or Python: the start script uses only `sh`, `curl`, `awk`, `grep`, `sed`.
- Repository names: `pacha` and `plus`. Folder uids stay `start-here`, `gallery`, `plus`. Dashboard uids do not change.
- `pacha`: `target: folderless`. `plus`: `target: folder` (wrapper folder uid `plus`, title Plus). Both `workflows: [write]`.
- Sync interval: 10 s for `local`, 60 s for `github`.
- `PACHA_REPO_TYPE` is `local` (default) or `github`. GitHub: `PACHA_GIT_URL` (default `https://github.com/ubica-ecuador/pacha`), `PACHA_GIT_BRANCH` (default `main`), `PACHA_GIT_TOKEN` (no default; fine-grained, contents read-write on that repo only).
- Canonical file format: keys sorted, two-space indent, `<` `>` `&` as `<` `>` `&`, no trailing newline, non-ASCII kept as is.
- Tag vocabulary (closed): engine `chaski` `duckdb` `infinity`; visualization `kepler` `kepler-plus` `business-charts` `business-table`; theme `seismic` `mobility` `transit` `energy` `air-quality` `gps` `live`. No tag repeats a folder.
- Admin credentials come from `GF_SECURITY_ADMIN_USER` / `GF_SECURITY_ADMIN_PASSWORD`, already in the grafana service's environment.
- `compose.plus.yaml`, `plus/provisioning-datasources/` and `provisioning/datasources/plus-testdata.yaml` hold the user's own uncommitted work (the TestData source). Before Task 3, ask the user to commit it; never commit it as part of this plan.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Plus dashboards saved in the UI but never exported.** The Plus provider had `allowUiUpdates`, so the database may hold edits the files lack; the migration would drop them. Task 1 step 1 compares database against file and stops if they differ.
2. **A dev clone without the ACLs.** Saves would fail with a permission error. The start script logs a warning naming `scripts/dev-acl.sh`; Task 2 step 6 checks it.
3. **A classic folder that is not empty** (someone saved a dashboard by hand into Gallery on a public instance). The script must refuse and keep the healthcheck red, never delete it. Task 2 step 3 exercises it on a throwaway Grafana.
4. **The Plus overlay switched off and on.** Off must remove the Plus folder and its dashboards; on must bring them back with the same uids. Task 3 step 4.
5. **`github` type without a token.** The script must say `PACHA_GIT_TOKEN is not set` and stay red, not create a broken repository. Task 4 step 2.

---

## File structure

| Path | Responsibility |
|---|---|
| `provisioning/repositories/start.sh` | Grafana's entrypoint: migrates classic folders, applies or deletes repositories, writes the health marker, `exec`s `/run.sh` |
| `provisioning/repositories/pacha/local.yaml`, `github.yaml` | The `pacha` Repository, one file per type |
| `provisioning/repositories/plus/README.md` | Placeholder: the Plus overlay mounts `plus/repositories/` here |
| `plus/repositories/local.yaml`, `github.yaml` | The `plus` Repository, one file per type |
| `dashboards/start-here/_folder.json`, `dashboards/gallery/_folder.json` | Folder uid and title |
| `scripts/dev-acl.sh` | One-time host ACLs so uid 472 can write the dashboard folders |
| `dashboards/README.md` | Folders, tag vocabulary, conventions, how saves reach git, showcase backlog |
| `compose.yaml`, `compose.plus.yaml` | Entrypoint, `init`, env, read-write mounts, healthcheck, overlay mounts |
| `README.md`, `.env.example` | How to run dev and a public instance |
| Removed: `provisioning/dashboards/providers.yaml`, `provisioning/dashboards/plus.yaml`, `plus/provisioning-dashboards/` | Classic dashboard providers |

---

### Task 1: Dashboard content — tags, titles, description, canonical format

Works under the classic providers still in place; nothing else depends on Git Sync yet.

**Files:**
- Modify: all six `dashboards/*/*.json` and `plus/dashboards/*.json`
- Create: `dashboards/README.md`

**Interfaces:**
- Produces: files in canonical format with the tags and titles below. Task 2 relies on them being canonical so the first Grafana write is a small diff.

- [ ] **Step 1: Stop if the database holds edits the files lack**

Save as `$SCRATCH/compare.py` (`$SCRATCH` is the session scratchpad):

```python
import json, sys, urllib.request, base64
AUTH = base64.b64encode(b'admin:admin').decode()
def live(uid):
    req = urllib.request.Request(f'http://localhost:3000/apis/dashboard.grafana.app/v2beta1/namespaces/default/dashboards/{uid}',
                                 headers={'Authorization': 'Basic ' + AUTH})
    return json.load(urllib.request.urlopen(req))['spec']
differ = []
for path in sys.argv[1:]:
    f = json.load(open(path, encoding='utf-8'))
    if live(f['metadata']['name']) != f['spec']:
        differ.append(path)
print('DIFFER:' if differ else 'all match', *differ)
```

Run: `python3 -I $SCRATCH/compare.py dashboards/*/*.json plus/dashboards/*.json`
Expected: `all match`. If any file is listed, stop and ask the user whether to export the database version into that file first (`GET` the URL above, write `{"apiVersion","kind","metadata":{"name"},"spec"}`).

- [ ] **Step 2: Rewrite the six files**

Save as `$SCRATCH/retag.py`:

```python
import json, sys
TAGS = {
    'earthquakes':           ['chaski', 'kepler', 'business-charts', 'business-table', 'seismic'],
    'nyc-taxi-trips':        ['chaski', 'kepler', 'business-charts', 'mobility'],
    'gps-truck-track':       ['infinity', 'kepler', 'gps'],
    'air-quality':           ['chaski', 'kepler-plus', 'business-charts', 'air-quality', 'live'],
    'germany-power-borders': ['chaski', 'infinity', 'kepler-plus', 'energy', 'live'],
    'gtfs-rt-mbta-fleet':    ['chaski', 'kepler', 'kepler-plus', 'transit', 'live'],
}
TITLES = {
    'germany-power-borders': "Germany's power borders — live",
    'gtfs-rt-mbta-fleet':    'Real-time public transit — MBTA',
}
DESCRIPTIONS = {
    'gps-truck-track': 'A truck’s GPS track on the map, with its speed and elevation over time; brush the curves to replay part of the trip.',
}
def canonical(obj):
    s = json.dumps(obj, indent=2, ensure_ascii=False, sort_keys=True)
    return s.replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
for path in sys.argv[1:]:
    d = json.load(open(path, encoding='utf-8'))
    uid = d['metadata']['name']
    d['spec']['tags'] = TAGS[uid]
    d['spec']['title'] = TITLES.get(uid, d['spec']['title'])
    if uid in DESCRIPTIONS:
        d['spec']['description'] = DESCRIPTIONS[uid]
    open(path, 'w', encoding='utf-8').write(canonical(d))
    print(uid, d['spec']['title'], d['spec']['tags'])
```

Before running it, open `dashboards/gallery/gps-truck-track.json` in Grafana and confirm the description is accurate (the panels are GPS position, distance/duration/speed/elevation stats, Speed and Elevation curves, and `brush_from`/`brush_to` variables). Adjust the sentence if not.

Run: `python3 -I $SCRATCH/retag.py dashboards/*/*.json plus/dashboards/*.json`
Expected: six lines, each with the title and tags above.

- [ ] **Step 3: Verify nothing but tags, titles and that description changed**

Run:

```bash
for f in dashboards/*/*.json plus/dashboards/*.json; do
  python3 -I -c "
import json,sys
a=json.loads(open(sys.argv[1]).read()); b=json.loads(sys.argv[2])
for d in (a,b):
  for k in ('tags','title','description'): d['spec'].pop(k,None)
print(sys.argv[1], 'same' if a==b else 'CHANGED')" "$f" "$(git show HEAD:"$f")"
done
```

Expected: six `same`.

- [ ] **Step 4: Verify the format is canonical**

Save as `$SCRATCH/is_canonical.py`, with the same `canonical` as `retag.py`:

```python
import json, sys
def canonical(obj):
    s = json.dumps(obj, indent=2, ensure_ascii=False, sort_keys=True)
    return s.replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
for path in sys.argv[1:]:
    raw = open(path, encoding='utf-8').read()
    print(path, raw == canonical(json.loads(raw)))
```

Run: `python3 -I $SCRATCH/is_canonical.py dashboards/*/*.json plus/dashboards/*.json`
Expected: six lines ending in `True`.

- [ ] **Step 5: Write `dashboards/README.md`**

```markdown
# Dashboards

Every dashboard here is synced with Grafana by Git Sync. A save in Grafana,
from the UI or from an agent through MCP, writes the file. In dev it shows up
in `git status`; on a public instance it is a commit on `main`. A change to a
file (an edit, `git pull`, a branch switch) reaches Grafana within 10 s in dev,
60 s on a public instance.

## Folders

One directory per folder. Its `_folder.json` holds the folder's uid and title.

| Folder     | Directory                 | Holds                                  |
|------------|---------------------------|----------------------------------------|
| Start here | `start-here/`             | the one or two dashboards to open first |
| Gallery    | `gallery/`                | examples on the free stack             |
| Plus       | `../plus/dashboards/`     | what needs Kepler Plus; only with the Plus overlay |

## Tags

A closed vocabulary. Add a theme tag in the same change as the dashboard that
needs it; the other facets change only with the stack.

- **Engine, at least one:** `chaski` (queries in the browser), `duckdb`
  (queries on the server), `infinity` (reads HTTP or JSON).
- **Visualization:** `kepler`, `kepler-plus`, `business-charts`,
  `business-table`.
- **Theme and behaviour:** `seismic`, `mobility`, `transit`, `energy`,
  `air-quality`, `gps`, `live` (feeds that reload by themselves).

No tag repeats a folder: filter what needs Plus with `kepler-plus`.

## Conventions

1. The file name is the dashboard's uid (`metadata.name`), in kebab-case.
2. The description is never empty: it is what the list and search show.
3. Tags come from the vocabulary above and include at least one engine.
4. Datasources are referenced by their provisioned uid only: `duckdb`,
   `infinity`, `duckdbwasm` (Chaski). That is what makes a dashboard work on
   every environment.
5. Files are in Grafana's own format: keys sorted, two-space indent, `<` `>`
   `&` escaped, no trailing newline. A file edited by hand may drift; Grafana
   rewrites it on the next save, once.
6. A title says what the dashboard shows. Engines and plugins go in tags.

## Backlog

Showcase dashboards still to build, each its own piece of work:

1. **GFS forecast with TiTiler.** NOAA's forecast, which TiTiler preloads from
   Icechunk, as map tiles, with per-area statistics computed in DuckDB.
2. **Satellite scenes by STAC.** A STAC search through `http_client`, filtered
   by the time range; the scene on the map through TiTiler; band algebra with
   the `raster` extension.
3. **H3 over a large Parquet.** A public dataset too large for the browser,
   read remotely and aggregated into `h3` or `a5` cells on the server.
4. **An Iceberg table.** A public Iceberg table read with time travel between
   snapshots.

When the first DuckDB dashboard exists, Start here should show one dashboard
per engine.
```

- [ ] **Step 6: Check the stack still shows them**

Run: `docker compose restart grafana && docker compose up --wait && curl -s -u admin:admin 'http://localhost:3000/api/search?type=dash-db' | python3 -I -c "import json,sys; [print(x['folderUid'], x['title'], x['tags']) for x in json.load(sys.stdin)]"`
Expected: six dashboards in `start-here`, `gallery`, `plus`, with the new titles and tags.

- [ ] **Step 7: Commit**

```bash
git add dashboards/ plus/dashboards/
git commit -m "feat: dashboards tagged by engine, plugin and theme, in Grafana's own format

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Git Sync for `dashboards/` — start script, `pacha` repository, migration

**Files:**
- Create: `provisioning/repositories/start.sh` (mode 755), `provisioning/repositories/pacha/local.yaml`, `provisioning/repositories/plus/README.md`, `dashboards/start-here/_folder.json`, `dashboards/gallery/_folder.json`, `scripts/dev-acl.sh` (mode 755)
- Modify: `compose.yaml` (grafana service)
- Delete: `provisioning/dashboards/providers.yaml`, `dashboards/gallery/.gitkeep`

**Interfaces:**
- Consumes: canonical dashboard files from Task 1.
- Produces: the start script's contract, which Tasks 3 and 4 rely on — every subfolder `X` of `provisioning/repositories/` is the Repository named `X`; `X/$PACHA_REPO_TYPE.yaml` is applied with `${VAR}` substituted from the environment (an unset or empty variable is an error); a subfolder with no file for that type deletes Repository `X`. Health marker: `/tmp/pacha-repositories-applied`.

- [ ] **Step 1: Write the start script**

`provisioning/repositories/start.sh`:

```sh
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
```

Run: `chmod 755 provisioning/repositories/start.sh && sh -n provisioning/repositories/start.sh && echo syntax-ok`
Expected: `syntax-ok`

- [ ] **Step 2: Write the `pacha` definition, the Plus placeholder and the folder files**

`provisioning/repositories/pacha/local.yaml`:

```yaml
# dashboards/ in this clone, read-write. Each subfolder is a top-level folder.
apiVersion: provisioning.grafana.app/v0alpha1
kind: Repository
metadata:
  name: pacha
spec:
  title: Pacha
  type: local
  local:
    path: /var/lib/pacha/dashboards
  sync:
    enabled: true
    target: folderless
    intervalSeconds: 10
  workflows: [write]
```

`provisioning/repositories/plus/README.md`:

```markdown
Empty on purpose: compose.plus.yaml mounts plus/repositories here. With no
definition in it, start.sh deletes the `plus` repository and its dashboards.
The folder has to exist, since provisioning/ is mounted read-only and Docker
cannot create a mountpoint inside it.
```

`dashboards/start-here/_folder.json` (canonical format, no trailing newline):

```json
{
  "apiVersion": "folder.grafana.app/v1beta1",
  "kind": "Folder",
  "metadata": {
    "name": "start-here"
  },
  "spec": {
    "title": "Start here"
  }
}
```

`dashboards/gallery/_folder.json`: the same with `gallery` and `Gallery`.

Write both with `printf '%s'` or Python so there is no trailing newline. Then `git rm dashboards/gallery/.gitkeep`.

- [ ] **Step 3: Exercise `render` and the busy-folder refusal on a throwaway Grafana**

`render` in the image's `awk` (mawk):

```bash
docker run --rm --entrypoint sh -e A=one -e B= -v "$PWD/provisioning/repositories:/r:ro" ghcr.io/ubica-ecuador/pacha-grafana:dev -c '
  sed -n "/^render()/,/^}/p" /r/start.sh > /tmp/f.sh; . /tmp/f.sh
  printf "x: \${A}\ny: \${A}-\${A}\n" > /tmp/t; render /tmp/t
  printf "z: \${B}\n" > /tmp/u; render /tmp/u; echo "exit=$?"'
```

Expected: `x: one`, `y: one-one`, then `pacha-repositories: B is not set` and `exit=1`.

Busy classic folder (Review Focus 3; the script retries five times, so this takes about three minutes): start a throwaway Grafana with a classic provider for `gallery` and one dashboard, then add a second dashboard into that folder by hand, then remove the provider and boot it with the start script:

```bash
P=$SCRATCH/busy; rm -rf $P; mkdir -p $P/prov/dashboards $P/dash/gallery
cp dashboards/gallery/nyc-taxi-trips.json $P/dash/gallery/
printf 'apiVersion: 1\nproviders:\n  - name: gallery\n    folder: Gallery\n    folderUid: gallery\n    type: file\n    options:\n      path: /var/lib/pacha/dashboards/gallery\n' > $P/prov/dashboards/providers.yaml
docker volume create busy-data
docker run -d --name grafana-busy -p 127.0.0.1:3999:3000 -e GF_SECURITY_ADMIN_PASSWORD=admin -v busy-data:/var/lib/grafana -v $P/prov:/etc/grafana/provisioning -v $P/dash:/var/lib/pacha/dashboards ghcr.io/ubica-ecuador/pacha-grafana:dev
until curl -fs http://127.0.0.1:3999/api/health >/dev/null; do sleep 2; done
curl -s -u admin:admin -H 'Content-Type: application/json' -X POST http://127.0.0.1:3999/api/dashboards/db -d '{"dashboard":{"title":"Hand-made","uid":"hand-made"},"folderUid":"gallery"}'
docker rm -f grafana-busy
printf 'apiVersion: 1\nproviders: []\n' > $P/prov/dashboards/providers.yaml
mkdir -p $P/prov/repositories/pacha && cp provisioning/repositories/start.sh $P/prov/repositories/ && cp provisioning/repositories/pacha/local.yaml $P/prov/repositories/pacha/
docker run -d --name grafana-busy -p 127.0.0.1:3999:3000 --entrypoint /etc/grafana/provisioning/repositories/start.sh -e GF_SECURITY_ADMIN_PASSWORD=admin -e GF_SECURITY_ADMIN_USER=admin -e PACHA_REPO_TYPE=local -e GF_PATHS_PERMITTED_PROVISIONING_PATHS=/var/lib/pacha -e 'GF_PROVISIONING_REPOSITORY_TYPES=local|github' -v busy-data:/var/lib/grafana -v $P/prov:/etc/grafana/provisioning -v $P/dash:/var/lib/pacha/dashboards ghcr.io/ubica-ecuador/pacha-grafana:dev
for i in $(seq 60); do docker logs grafana-busy 2>&1 | grep -q 'NOT applied' && break; sleep 5; done
docker logs grafana-busy 2>&1 | grep pacha-repositories; docker exec grafana-busy test -f /tmp/pacha-repositories-applied && echo MARKER || echo no-marker
curl -s -u admin:admin http://127.0.0.1:3999/api/dashboards/uid/hand-made -o /dev/null -w 'hand-made: %{http_code}\n'
docker rm -f grafana-busy; docker volume rm busy-data
```

Expected: the log says `folder gallery is left from the classic providers and still holds dashboards…` and `repositories NOT applied`, then `no-marker`, then `hand-made: 200`.

- [ ] **Step 4: Write `scripts/dev-acl.sh`**

```sh
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
```

Run: `chmod 755 scripts/dev-acl.sh` (do not run it yet; Step 6 checks the warning first).

- [ ] **Step 5: Change `compose.yaml` and remove the classic provider**

In the grafana service, add `entrypoint` and `init`, the environment entries, make the dashboards mount read-write, and replace the healthcheck:

```yaml
  grafana:
    build: …unchanged…
    image: …unchanged…
    # Applies the Git Sync repositories in provisioning/repositories/, then runs
    # the image's /run.sh. init reaps the script's background job.
    entrypoint: ['/etc/grafana/provisioning/repositories/start.sh']
    init: true
    environment:
      …existing GF_SECURITY_* and GF_SERVER_ROOT_URL unchanged…
      # Git Sync: local repositories may only point under /var/lib/pacha.
      GF_PATHS_PERMITTED_PROVISIONING_PATHS: /var/lib/pacha
      GF_PROVISIONING_REPOSITORY_TYPES: 'local|github'
      # local: this clone's dashboards/, read-write (dev). github: main of the
      # repo on GitHub, which a public instance commits to. See .env.example.
      PACHA_REPO_TYPE: ${PACHA_REPO_TYPE:-local}
      PACHA_GIT_URL: ${PACHA_GIT_URL:-https://github.com/ubica-ecuador/pacha}
      PACHA_GIT_BRANCH: ${PACHA_GIT_BRANCH:-main}
      PACHA_GIT_TOKEN: ${PACHA_GIT_TOKEN:-}
    volumes:
      - grafana-data:/var/lib/grafana
      - ./provisioning:/etc/grafana/provisioning:ro
      # Read-write: Git Sync writes saves back here. See scripts/dev-acl.sh.
      - ./dashboards:/var/lib/pacha/dashboards
    networks: …unchanged…
    healthcheck:
      # Healthy once the Git Sync repositories are applied too (start.sh).
      test: ['CMD-SHELL', 'curl -fsS http://localhost:3000/api/health && test -f /tmp/pacha-repositories-applied']
      interval: 5s
      timeout: 3s
      retries: 30
      start_period: 20s
```

Then: `git rm provisioning/dashboards/providers.yaml`. Leave `provisioning/dashboards/plus.yaml` for Task 3.

Run: `docker compose config --format json | python3 -I -c "import json,sys; g=json.load(sys.stdin)['services']['grafana']; print(g['entrypoint'], g['init'], g['environment']['PACHA_REPO_TYPE'], [v for v in g['volumes'] if v['target']=='/var/lib/pacha/dashboards'][0].get('read_only'))"`
Expected: `['/etc/grafana/provisioning/repositories/start.sh'] True local None`

- [ ] **Step 6: Migrate the dev stack and check the ACL warning**

This task runs **without the Plus overlay**: the user's `.env` turns it on, and its classic provider (removed in Task 3) would keep the Plus folder busy. Every `docker compose` command in Steps 6 and 7 is prefixed with `COMPOSE_FILE=compose.yaml`. Without the overlay Grafana drops the Plus dashboards and the script deletes the empty classic Plus folder; Task 3 brings them back.

Run: `COMPOSE_FILE=compose.yaml docker compose up -d --wait grafana; docker compose logs grafana | grep pacha-repositories`
Expected: `WARNING: Grafana cannot write /var/lib/pacha/dashboards…`, `deleted the empty classic folder start-here`, `… gallery`, `… plus`, `applied pacha (local)`, `repositories applied`. `up --wait` succeeds.

Then run `scripts/dev-acl.sh` and `COMPOSE_FILE=compose.yaml docker compose restart grafana && COMPOSE_FILE=compose.yaml docker compose up --wait`.
Expected: the warning is gone.

- [ ] **Step 7: Verify sync both ways**

```bash
# Dashboards back in their folders, owned by the repository
curl -s -u admin:admin 'http://localhost:3000/api/search?type=dash-db' | python3 -I -c "import json,sys; [print(x['folderUid'], x['uid']) for x in json.load(sys.stdin)]"
curl -s -u admin:admin http://localhost:3000/apis/dashboard.grafana.app/v2beta1/namespaces/default/dashboards/earthquakes | python3 -I -c "import json,sys; a=json.load(sys.stdin)['metadata']['annotations']; print(a['grafana.app/managedBy'], a['grafana.app/managerId'], a['grafana.app/sourcePath'])"
git status --short dashboards/
```

Expected: `start-here earthquakes`, `gallery gps-truck-track`, `gallery nyc-taxi-trips`; `repo pacha start-here/earthquakes.json`; `git status` clean (Task 1 made the files canonical).

Grafana to git: save through mcp-grafana's path (the `dashboard.grafana.app` API):

```bash
curl -s -u admin:admin http://localhost:3000/apis/dashboard.grafana.app/v2beta1/namespaces/default/dashboards/nyc-taxi-trips > $SCRATCH/n.json
python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); d['spec']['description']+=' (sync check)'; json.dump(d,open(sys.argv[1],'w'))" $SCRATCH/n.json
curl -s -o /dev/null -w '%{http_code}\n' -u admin:admin -H 'Content-Type: application/json' -X PUT http://localhost:3000/apis/dashboard.grafana.app/v2beta1/namespaces/default/dashboards/nyc-taxi-trips -d @$SCRATCH/n.json
sleep 2; git diff --stat dashboards/
```

Expected: `200`, then `dashboards/gallery/nyc-taxi-trips.json | 2 +-`.

Git to Grafana: `git checkout dashboards/gallery/nyc-taxi-trips.json; sleep 15` and read the description back through the API.
Expected: no ` (sync check)` suffix.

- [ ] **Step 8: Commit**

```bash
git add provisioning/repositories/ dashboards/ scripts/dev-acl.sh compose.yaml
git commit -m "feat: dashboards/ synced with Grafana by Git Sync, saves land in the working tree

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Git Sync for `plus/dashboards/` — the `plus` repository and the overlay

Before starting, ask the user to commit their own pending work in `compose.plus.yaml`, `plus/provisioning-datasources/` and `provisioning/datasources/plus-testdata.yaml`.

**Files:**
- Create: `plus/repositories/local.yaml`
- Modify: `compose.plus.yaml`
- Delete: `plus/provisioning-dashboards/plus.yaml`, `provisioning/dashboards/plus.yaml`

**Interfaces:**
- Consumes: the start script contract from Task 2 (subfolder `plus/` = Repository `plus`; empty folder deletes it).

- [ ] **Step 1: Write `plus/repositories/local.yaml`**

```yaml
# plus/dashboards/ in this clone, read-write, inside the Plus folder (whose uid
# is this repository's name). compose.plus.yaml mounts this folder over
# provisioning/repositories/plus/.
apiVersion: provisioning.grafana.app/v0alpha1
kind: Repository
metadata:
  name: plus
spec:
  title: Plus
  type: local
  local:
    path: /var/lib/pacha/plus-dashboards
  sync:
    enabled: true
    target: folder
    intervalSeconds: 10
  workflows: [write]
```

- [ ] **Step 2: Change `compose.plus.yaml`**

Remove the mount of `./plus/provisioning-dashboards/plus.yaml`. Make the `./plus/dashboards` mount read-write (drop `read_only: true`, with a comment pointing at `scripts/dev-acl.sh`). Add:

```yaml
      # The plus Repository; without this mount, start.sh deletes it.
      - type: bind
        source: ./plus/repositories
        target: /etc/grafana/provisioning/repositories/plus
        read_only: true
```

Update the header comment: Plus dashboards come from the `plus` Git Sync repository, not a classic provider.

Then: `git rm -r plus/provisioning-dashboards provisioning/dashboards/plus.yaml`. If `provisioning/dashboards/` is now empty, leave it out entirely (nothing mounts into it any more).

Run: `docker compose config --format json | python3 -I -c "import json,sys; g=json.load(sys.stdin)['services']['grafana']; [print(v['target'], v.get('read_only')) for v in g['volumes'] if 'pacha' in v['target'] or 'repositories' in v['target']]"`
Expected: `/var/lib/pacha/dashboards None`, `/etc/grafana/provisioning/repositories/plus True`, `/var/lib/pacha/plus-dashboards None`, and no `provisioning/dashboards/plus.yaml` target.

- [ ] **Step 3: Migrate and verify with the overlay on**

Run: `docker compose up -d --wait grafana; docker compose logs grafana | grep pacha-repositories | tail -3`
Expected: `applied pacha (local)`, `applied plus (local)`, `repositories applied` (the classic Plus folder already went in Task 2).

Run: `curl -s -u admin:admin 'http://localhost:3000/api/search?type=dash-db' | python3 -I -c "import json,sys; [print(x['folderUid'], x['uid']) for x in json.load(sys.stdin)]"; curl -s -u admin:admin http://localhost:3000/api/folders/plus | python3 -I -c "import json,sys; print(json.load(sys.stdin)['title'])"; git status --short plus/`
Expected: the three Plus dashboards in `plus`, title `Plus`, `git status` clean.

- [ ] **Step 4: Overlay off, then on again (Review Focus 4)**

```bash
COMPOSE_FILE=compose.yaml docker compose up -d --wait grafana
docker compose logs grafana | grep 'deleted plus'
curl -s -u admin:admin 'http://localhost:3000/api/search?type=dash-db' | python3 -I -c "import json,sys; print(sorted(x['uid'] for x in json.load(sys.stdin)))"
docker compose up -d --wait grafana
sleep 15; curl -s -u admin:admin 'http://localhost:3000/api/search?type=dash-db' | python3 -I -c "import json,sys; print(sorted((x['folderUid'],x['uid']) for x in json.load(sys.stdin)))"
```

Expected: `deleted plus: it has no local definition`; then only the three free dashboards; then all six, the Plus ones back in `plus` with the same uids.

- [ ] **Step 5: Commit**

```bash
git add plus/repositories/ compose.plus.yaml
git commit -m "feat: Plus dashboards synced by their own Git Sync repository, present only with the overlay

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(`git rm` from Step 2 is already staged.)

---

### Task 4: Public instances — `github` definitions and docs

**Files:**
- Create: `provisioning/repositories/pacha/github.yaml`, `plus/repositories/github.yaml`
- Modify: `.env.example`, `README.md`

- [ ] **Step 1: Write the `github` definitions**

`provisioning/repositories/pacha/github.yaml`:

```yaml
# main of the repo on GitHub (public instances): a save in Grafana is a commit
# there. Polls every 60 s; no webhook, so GitHub never has to reach Grafana.
apiVersion: provisioning.grafana.app/v0alpha1
kind: Repository
metadata:
  name: pacha
spec:
  title: Pacha
  type: github
  github:
    url: ${PACHA_GIT_URL}
    branch: ${PACHA_GIT_BRANCH}
    path: dashboards/
  sync:
    enabled: true
    target: folderless
    intervalSeconds: 60
  workflows: [write]
secure:
  token:
    create: "${PACHA_GIT_TOKEN}"
```

`plus/repositories/github.yaml`: the same with `name: plus`, `title: Plus`, `path: plus/dashboards/`, `target: folder`, and the first comment line saying it is the Plus overlay's.

- [ ] **Step 2: Missing token stays red (Review Focus 5) and the definition validates**

```bash
PACHA_REPO_TYPE=github COMPOSE_FILE=compose.yaml docker compose up -d grafana
sleep 40; docker compose logs grafana | grep pacha-repositories | tail -3
docker compose ps grafana --format '{{.Health}}'
```

Expected: `PACHA_GIT_TOKEN is not set`, `repositories NOT applied`, health `starting` or `unhealthy`. Then validate the rendered definition without creating anything:

```bash
sed -e 's|${PACHA_GIT_URL}|https://github.com/ubica-ecuador/pacha|' -e 's|${PACHA_GIT_BRANCH}|main|' -e 's|${PACHA_GIT_TOKEN}|dummy|' provisioning/repositories/pacha/github.yaml > $SCRATCH/gh.yaml
curl -s -u admin:admin -H 'Content-Type: application/yaml' -X PUT 'http://localhost:3000/apis/provisioning.grafana.app/v0alpha1/namespaces/default/repositories/pacha?dryRun=All' --data-binary @$SCRATCH/gh.yaml | head -c 400
```

Expected: either a `Repository` echoed back, or a `Status` that complains only about the token or the type change (a dry run against the existing `local` repository). Any schema error ("unknown field", "Required value" on a field the file sets) is a bug in the file.

Restore dev: `docker compose up -d --wait grafana` (with `.env` as it was).

- [ ] **Step 3: Document in `.env.example`**

Append:

```sh
# Git Sync. local (the default, dev): Grafana syncs with this clone's
# dashboards/ and plus/dashboards/, and a save lands in the working tree; run
# scripts/dev-acl.sh once so Grafana may write there. github (public
# instances): Grafana syncs with main on GitHub, and a save is a commit there,
# signed with the Grafana user's name. Keep one type per instance: changing
# it in place needs a new token.
# PACHA_REPO_TYPE=github
# PACHA_GIT_URL=https://github.com/ubica-ecuador/pacha
# PACHA_GIT_BRANCH=main
# Fine-grained token: Contents read and write on ubica-ecuador/pacha only.
# PACHA_GIT_TOKEN=
```

- [ ] **Step 4: Document in `README.md`**

After "Run it", add:

```markdown
## Dashboards

Grafana's Git Sync keeps the dashboards in `dashboards/` (and `plus/dashboards/`
with the Plus overlay) in step with Grafana. In dev, a save in Grafana, from the
UI or from an agent through MCP, writes the file in this clone; commit it like
any other change. Run once per clone, so Grafana may write there:

    scripts/dev-acl.sh

On a public instance, set `PACHA_REPO_TYPE=github` and `PACHA_GIT_TOKEN` in
`.env` (see `.env.example`): Grafana then follows `main` on GitHub and commits
each save to it. Folders, tags and conventions: [dashboards/README.md](dashboards/README.md).
```

- [ ] **Step 5: Commit**

```bash
git add provisioning/repositories/pacha/github.yaml plus/repositories/github.yaml .env.example README.md
git commit -m "feat: public instances sync dashboards with main on GitHub

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Regression and cleanup

- [ ] **Step 1: Existing suites**

Run: `npm run test:config && npm run test:stack`
Expected: all pass, including `earthquakes … is provisioned in Start here under its old uid` and `air-quality … is provisioned in Plus`. A failure here is a regression of this plan; fix it in the task that caused it.

- [ ] **Step 2: Leftovers**

Run: `git status --short; ls provisioning/dashboards 2>/dev/null; docker ps -a --filter name=grafana-busy --format '{{.Names}}'; docker volume ls -q | grep -E 'busy|probe'`
Expected: only the user's own pending files, if any; no `provisioning/dashboards`; no throwaway containers or volumes.

- [ ] **Step 3: Spec status**

In the spec, change `Status: approved` to `Status: implemented` and commit:

```bash
git add docs/superpowers/specs/2026-10-07-dashboards-git-sync-design.md
git commit -m "docs: Git Sync design implemented

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
