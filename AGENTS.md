# Pacha, for agents

Pacha is an open spatio-temporal stack: Grafana with DuckDB on the server, DuckDB-WASM in the
browser (Chaski), Kepler.gl map panels and Business Charts, behind an nginx gateway that
caches and keys the public feeds. The commercial Kepler Plus panel is an optional overlay
(`compose.plus.yaml`). Most work here is **building dashboards**.
[README.md](README.md) is how to run the stack; [dashboards/README.md](dashboards/README.md) is
the folder, tag and file conventions.

This file is policy. How to build a dashboard, with recipes, lives in the skill
[.claude/skills/build-dashboard/](.claude/skills/build-dashboard/SKILL.md). Read its SKILL.md
before writing or editing any dashboard, then only the reference files the task needs.

**Your instance.** Facts about one deployment (its URL, ports, who approves what, how the
host runs docker) do not belong in this repository. Keep them in `CLAUDE.local.md` at the
repo root, which git ignores and Claude Code loads by itself; other agents should read it
when it exists.

## Rules

1. **Know where a dashboard change lands.** Git Sync keeps `dashboards/` and
   `plus/dashboards/` in step with Grafana. With `PACHA_REPO_TYPE=local` (the default) a save
   in Grafana writes the file and a file edit reaches Grafana within a minute. With
   `PACHA_REPO_TYPE=github` the instance follows the branch on GitHub: **a push is live**, and a
   save in Grafana is a commit. On such an instance, show the user a preview copy first and push
   only after they approve (see [workflow.md](.claude/skills/build-dashboard/references/workflow.md)).
2. **Never write into a synced folder by API or MCP** to try something out. Saving into the
   `gallery` or `plus` folders writes the repository (or GitHub). Previews go in a separate,
   non-synced folder.
3. **Merge onto the latest save.** People edit dashboards in Grafana, and those saves land in
   the files. Before changing an existing dashboard, start from its latest version (pull first
   on a GitHub-synced instance) and change only the panels and variables the task is about.
   Never regenerate a whole dashboard from a script.
4. **Datasources by uid only:** `duckdb` (server), `duckdbwasm` (Chaski), `infinity`. That is
   what makes a dashboard work on every instance.
5. **Remote data that needs a key, a cache or a polite rate goes through the gateway**
   (`http://feeds/...`). Anyone who can view a dashboard can send SQL to `duckdb`: never put a
   secret in SQL or in a dashboard. Keys live in `.env` and are added by the gateway.
6. **No visual claim without a screenshot.** Do not say a map or chart "shows" something until
   you have rendered the dashboard and looked at the image. Facts read from rows are rows, not
   map observations.
7. **Each new dashboard gets basic tests** in `tests/stack/<uid>.test.mjs`: conventions, the
   datasets return sane rows, it loads with no panel in error. A handful, not a suite.
8. **Commit only your own changes.** Stage the files (or hunks) you changed, nothing else;
   another agent or person may be working in the same clone. Never force-push.
9. **Ask before** restarting shared services, changing the Git Sync mode, or deleting anything
   you did not create.

## Running things

- Node 22 or later (`package.json` engines). With an older system node:
  `npx -y -p node@22 node ...`.
- `STACK_URL` is where the gateway answers: `http://127.0.0.1:<STACK_PORT>` (default 3000;
  `docker compose port gateway 80` tells you). Use `127.0.0.1`: Node may resolve `localhost`
  to `::1`.
- Load `.env` (`node --env-file=.env`) when talking to Grafana as admin. Without it the test
  helpers fall back to `admin:admin`; a run of failed logins locks the admin user for minutes.
- The MCP server (`mcp` service, wired in `.mcp.json`) has the `dashboard`, `datasource`,
  `search` and `runpanelquery` tools. Its token is read from `PACHA_MCP_TOKEN` in `.env` by
  `scripts/mcp-headers.sh`; Claude Code runs it once the workspace is trusted.
  Use it to read dashboards and run panel queries; rule 2 applies to every write.

## The panels

- Kepler Geospatial Maps (free): https://github.com/ubica-ecuador/keplergl-grafana-panel, user
  guide at https://docs.ubica.dev. Its `provisioning-sources/dashboards/` is a bench of source
  recipes.
- Kepler Geospatial Maps Plus: documented in the same guide under `/plus/`.
- Chaski: https://github.com/ubica-ecuador/chaski.
