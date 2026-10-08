# Dashboards as code with Git Sync

Date: 2026-10-07
Status: implemented

## Problem

Pacha's dashboards are files in this repo, loaded by Grafana's classic file
provisioning. Edits happen in three places: by hand in the files, in Grafana's
UI, and by AI agents through mcp-grafana. The last two write to Grafana's
database only. Nothing carries those edits back to the repo, so they are lost
on the next restart (read-only providers) or silently overwritten by the file
(the Plus provider, with `allowUiUpdates`). Dashboards are also edited on more
than one environment, so the same dashboard drifts between them.

The showcase itself is uneven: tags repeat the folder on some dashboards and
not on others, titles carry technical suffixes, and no dashboard shows DuckDB
on the server, TiTiler or the DuckDB extensions the image bakes in.

## Goals

1. The repo is the single source of truth for every Pacha dashboard, on every
   environment.
2. A save from the UI or from an agent reaches the repo without a manual
   export.
3. Recreating an environment from scratch, volume included, restores every
   dashboard with the same uids, folders and URLs.
4. Folders and tags follow one written convention.

## Non-goals

- Tests that enforce the conventions. They live in a README only.
- Building new dashboards. The backlog below lists them; each is its own piece
  of work, after this one.
- The dashboards the Kepler Plus app installs by itself. The app is being
  changed to install a single demo dashboard, which Pacha leaves alone.

## What the spike established

Verified on the running stack, Grafana 13.2.1, against a scratch copy of the
dashboards:

- Git Sync (the `provisioning` feature) is on by default. The `local`
  repository type needs `[paths] permitted_provisioning_paths` to cover the
  mounted folder and `[provisioning] repository_types` to list `local`.
- With the `write` workflow, a save writes the file on disk within two
  seconds, both from the UI (provisioning files API) and from mcp-grafana's
  `update_dashboard` (the `dashboard.grafana.app` API). The legacy
  `/api/dashboards/db` refuses repository-managed dashboards; nothing in Pacha
  uses it.
- The `local` type polls at the repository's sync interval, so a change made
  on disk (an edit, `git pull`, a branch switch) reaches Grafana without any
  action.
- Grafana writes files in one deterministic format: keys sorted, two-space
  indent, `<` `>` `&` escaped as `<` `>` `&`, no trailing
  newline. The current files are 378 to 3,284 lines away from it.
- A directory becomes a folder. Without a `_folder.json` the folder uid is a
  hash of the path. With one, its `metadata.name` is the uid and `spec.title`
  the title.
- Git Sync refuses a dashboard whose uid is still owned by a classic provider
  ("managed by classic-file-provisioning").
- Deleting a Repository resource deletes its dashboards and folders from
  Grafana.
- Repository resources are created through the API only; there is no
  provisioning file for them.

## Design

### Repositories

Two Repository resources, both with `workflows: [write]`:

| Name    | Source              | Target       | Exists when            |
|---------|---------------------|--------------|------------------------|
| `pacha` | `dashboards/`       | `folderless` | always                 |
| `plus`  | `plus/dashboards/`  | `folder`, uid `plus`, title Plus | the Plus overlay is on |

`pacha` is folderless so that each subdirectory is a top-level folder (Start
here, Gallery). `plus` wraps its files in the Plus folder, so the stack without
the overlay never shows a dashboard whose panels it cannot draw.

Per environment, only the repository type and its connection details change:

| Environment | Type     | Points at                                   | Sync interval |
|-------------|----------|---------------------------------------------|---------------|
| dev         | `local`  | the bind-mounted folder, read-write          | 10 s          |
| public (grafana.ubica.ec and others) | `github` | `main` of `ubica-ecuador/pacha`, path `dashboards/` or `plus/dashboards/` | 60 s |

Public instances poll; no webhooks, so they need no public URL for GitHub to
reach. The GitHub token is fine-grained, with contents read-write on
`ubica-ecuador/pacha` only, and comes from `.env` (`PACHA_GIT_TOKEN`). A save
on a public instance is a commit on `main`, attributed to the Grafana user
(`provisioning.userAttribution` is on). In dev a save is a change in the
working tree, committed by hand like any other.

### Definitions and bootstrap

The Repository definitions are files in the repo, in the
`provisioning.grafana.app/v0alpha1` `Repository` shape (the API accepts YAML):

- `provisioning/repositories/pacha.yaml`
- `provisioning/repositories/plus.yaml`, an empty placeholder. The Plus
  overlay mounts `plus/repositories/plus.yaml` over it, the same pattern the
  overlay already uses for plugins and datasources, since `provisioning/` is
  mounted read-only.

Environment-specific values are `${VARIABLES}`: `PACHA_REPO_TYPE` (`local` or
`github`), the GitHub URL and branch, the token, the sync interval. Defaults
give dev.

No extra service. Compose replaces the grafana service's `entrypoint` with
`provisioning/repositories/start.sh`, a short script already inside the
mounted `provisioning/` folder. Compose's `post_start` hooks would be cleaner,
but need Compose 2.30 and the dev machine runs 2.27.1. The script:

1. Starts a background job, then `exec`s the image's own `/run.sh`, so
   Grafana stays the main process and receives stop signals as today. The
   service sets `init: true`, so Docker's init reaps the finished job.
2. The background job waits for `/api/health`, then for each definition:
   substitutes the variables with `awk` (the image has no `envsubst`, `jq` or
   Python), and `PUT`s it to
   `/apis/provisioning.grafana.app/v0alpha1/namespaces/default/repositories/<name>`
   with `curl`, which the healthcheck already relies on. Verified: a `PUT`
   without a `resourceVersion` creates a missing Repository (201) and updates
   an existing one.
3. An empty definition means the repository must not exist: the job deletes
   the Repository named after the file. Without the overlay, that removes
   `plus` and its dashboards.
4. On success it writes a marker file. The healthcheck requires the marker as
   well as `/api/health`, so `docker compose up --wait` fails when the
   repositories were not applied. On failure the job logs why to Grafana's
   stdout and writes no marker.

The script logs in with the admin credentials compose already passes to
Grafana, over `localhost` inside the container.

The Repository state lives in Grafana's database, in the `grafana-data`
volume. A restart keeps it; a new volume gets it back from the script on the
next start, and Git Sync then repopulates every dashboard from the files.

### Grafana configuration

Added to the grafana service in `compose.yaml`:

- `GF_PATHS_PERMITTED_PROVISIONING_PATHS=/var/lib/pacha`
- `GF_PROVISIONING_REPOSITORY_TYPES=local|github`
- In dev, the `dashboards/` mount becomes read-write, and so does the
  `plus/dashboards/` mount in `compose.plus.yaml`. Public instances do not
  need the mounts.

**File ownership in dev.** Grafana runs as uid 472, which cannot write files
owned by the developer. Running Grafana under the developer's uid fails against
an existing volume (`grafana.db` is `0640`, owned by 472: "attempt to write a
readonly database"), so Grafana keeps its uid. Instead, a one-time
`scripts/dev-acl.sh` grants uid 472 read-write on `dashboards/` and
`plus/dashboards/` through host ACLs, default ACLs included. Verified: 472 can
then modify files in place, create files and folders, and the developer can
still edit and delete everything, including what Grafana created. Files that
git checks out inherit the default ACL. Public instances need none of this.

### Folders

One directory per folder, flat, each with a `_folder.json` that keeps the
current uids, so existing URLs keep working:

| Folder     | Directory               | uid          | Holds                                   |
|------------|-------------------------|--------------|-----------------------------------------|
| Start here | `dashboards/start-here/`| `start-here` | the one or two dashboards to open first |
| Gallery    | `dashboards/gallery/`   | `gallery`    | examples on the free stack              |
| Plus       | `plus/dashboards/`      | `plus`       | what needs Kepler Plus (the wrapper folder of the `plus` repository) |

### Tags

A closed vocabulary in three facets:

- **Engine, at least one:** `chaski` (queries in the browser), `duckdb`
  (queries on the server), `infinity` (reads HTTP or JSON).
- **Visualization:** `kepler`, `kepler-plus`, `business-charts`,
  `business-table`.
- **Theme and behaviour:** `seismic`, `mobility`, `transit`, `energy`,
  `air-quality`, `gps`, and `live` for feeds that reload by themselves. A new
  dashboard extends this facet in the same change.

No tag repeats a folder: `start-here`, `gallery` and `plus` go. `kepler-plus`
filters what needs Plus.

### Conventions

Written in `dashboards/README.md`, which agents building dashboards through
MCP also read:

1. File name equals uid (`metadata.name`), kebab-case.
2. A non-empty description.
3. Tags from the vocabulary, with at least one engine.
4. Datasources referenced by their provisioned uid only (`duckdb`,
   `infinity`, `duckdbwasm`), so a dashboard works on every environment.
5. Grafana's canonical file format. A file edited by hand may drift from it;
   Grafana rewrites it on the next save, once.
6. Titles say what the dashboard shows, without technical suffixes.

## Migration of the six dashboards

| Dashboard (uid)           | Folder     | Tags                                                         | Title change |
|---------------------------|------------|--------------------------------------------------------------|--------------|
| `earthquakes`             | Start here | chaski, kepler, business-charts, business-table, seismic     | none |
| `nyc-taxi-trips`          | Gallery    | chaski, kepler, business-charts, mobility                    | none |
| `gps-truck-track`         | Gallery    | infinity, kepler, gps                                        | none |
| `air-quality`             | Plus       | chaski, kepler-plus, business-charts, air-quality, live      | none |
| `germany-power-borders`   | Plus       | chaski, infinity, kepler-plus, energy, live                  | "Germany's power borders — live" |
| `gtfs-rt-mbta-fleet`      | Plus       | chaski, kepler, kepler-plus, transit, live                   | "Real-time public transit — MBTA" |

`gps-truck-track` gets a description. Every file is normalized to the
canonical format once, by a script that is not kept.

Rollout, the same on dev and on a public instance:

1. Remove the classic dashboard providers: `provisioning/dashboards/providers.yaml`,
   the empty `provisioning/dashboards/plus.yaml` placeholder,
   `plus/provisioning-dashboards/`, and their mounts in `compose.plus.yaml`.
2. On start, Grafana deletes the dashboards of providers that no longer
   exist (verified), but keeps their folders, still marked as owned by classic
   provisioning, and Git Sync refuses to adopt them ("already managed by").
   The start script deletes each of `start-here`, `gallery` and `plus` when it
   is still classic-owned and empty, and stops with an error when it is not
   empty, rather than delete a dashboard someone saved there by hand. This step
   is a one-off migration and can go once every environment has run it.
3. The start script creates the repositories; the dashboards come back
   with the same uids and folders.

## Conflicts

- Dev and a public instance edit the same dashboard: the clash surfaces on
  `git pull` in dev and is resolved there like any git conflict. The canonical
  format keeps those conflicts small.
- Git Sync checks a file's hash before writing, so a public instance does not
  overwrite a `main` that moved on.

## Settled by probes

On a throwaway Grafana with its own volume:

1. Grafana under the developer's uid against an existing volume: fails; host
   ACLs instead (see File ownership in dev).
2. Removing a classic provider deletes its dashboards on start, not its
   folders (see Rollout).
3. Changing a Repository's type in place is refused without a new token. Each
   environment keeps one type; the start script reports the API's error and
   does not delete to work around it.
4. The `folder` target's wrapper folder takes the repository's name as uid
   (`plus`) and its title as title (Plus).

## Showcase backlog

Each one is its own piece of work, after this design is in place:

1. **GFS forecast with TiTiler.** NOAA's forecast, which TiTiler preloads from
   Icechunk, as map tiles, with per-area statistics computed in DuckDB.
2. **Satellite scenes by STAC.** A STAC search through `http_client`, filtered
   by the time range; the scene on the map through TiTiler; band algebra with
   the `raster` extension.
3. **H3 over a large Parquet.** A public dataset too large for the browser,
   read remotely and aggregated into `h3` or `a5` cells on the server, in
   contrast with Chaski.
4. **An Iceberg table.** A public Iceberg table read with time travel between
   snapshots.

When the first DuckDB dashboard exists, Start here should show one dashboard
per engine. That choice is made then.
