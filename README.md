# Pacha

*Pacha* is Quechua for the world and time as one.

Spatiotemporal visualization in Grafana, in one command. The stack bakes in:

- the [Kepler map panel](https://github.com/ubica-ecuador/keplergl-grafana-panel);
- [Chaski](https://github.com/ubica-ecuador/chaski), DuckDB in the browser;
- DuckDB and Infinity on the server;
- Business Charts, Business Table, Business Text and Business Variable.

A TiTiler serves the imagery.

> Not affiliated with Grafana Labs.

## Run it

```bash
docker compose up --wait
```

Open <http://localhost:3000>. Anonymous visitors can view; sign in as `admin` / `admin` to edit (set
`GF_SECURITY_ADMIN_PASSWORD` in `.env`, starting from `.env.example`). Is port 3000 taken? Run
`STACK_PORT=3100 docker compose up --wait`. When the stack is reached under another host name (not localhost), set `GF_SERVER_ROOT_URL` in `.env` to that URL — Grafana Live checks browser origins against it.

## Dashboards

Grafana's Git Sync keeps the dashboards in `dashboards/` (and `plus/dashboards/`
with the Plus overlay) in step with Grafana. In dev, a save in Grafana, from the
UI or from an agent through MCP, writes the file in this clone; commit it like
any other change. Run once per clone, so Grafana may write there:

```bash
scripts/dev-acl.sh
```

On a public instance, set `PACHA_REPO_TYPE=github` and `PACHA_GIT_TOKEN` in
`.env` (see `.env.example`): Grafana then follows `main` on GitHub and commits
each save to it. Folders, tags and conventions: [dashboards/README.md](dashboards/README.md).

## What runs

| Service   | What it does                                     | Reached at                        |
|-----------|--------------------------------------------------|-----------------------------------|
| `gateway` | nginx; the only published port                   | `:3000`                           |
| `grafana` | Grafana 13.2.1 with the plugins baked in         | `/`                               |
| `titiler` | Tiles for COG, Zarr and Icechunk                 | `/titiler/`                       |
| `mcp`     | [mcp-grafana](https://github.com/grafana/mcp-grafana) for AI agents | `http://127.0.0.1:8000/mcp`, `Authorization: Bearer $PACHA_MCP_TOKEN` |
| `recorder` | Keeps live feeds as Parquet for history panels; off unless `COMPOSE_PROFILES=recorder` | `http://feeds/recordings/` (inside the stack) |

Plugins and DuckDB's extensions are part of the image, so nothing is downloaded when the stack
starts. The dashboards read their data where it is published.

The recorder is what gives air-traffic-world its history: every minute it keeps what adsb.lol
said, about 9,000 aircraft, and keeps a week of it, by default. That is one request a minute to
adsb.lol around the clock and up to a few GB of disk in the `recordings` volume, which is why it
runs only when `COMPOSE_PROFILES=recorder` is set (see `.env.example`). Without it the live
panels work and the history panels are empty.

Some data cannot be read where it is published, or not republished as it is: those dashboards
read files built once on each instance, under `datasets/<name>/`, which the gateway serves to
Grafana's DuckDB only (`http://feeds/datasets/`). geolife-mobility needs
`datasets/geolife/build.sh`: GeoLife's GPS trajectories, cleaned and analysed into Parquet in
about three minutes (313 MB download, 8 GB of memory for DuckDB). Until it runs, that
dashboard's panels show errors.

## Working on the Kepler panel

```bash
KEPLER_DIST=../kepler-grafana/dist docker compose -f compose.yaml -f compose.dev.yaml up --wait
```

To bake main of the Kepler repo into the image instead of its pinned release,
set `KEPLER_PANEL_CHANNEL=edge` in `.env` and run `docker compose up -d --build --wait`.
Every push to Kepler's main is published as its `edge` pre-release; building
again picks up the latest. Grafana's plugin page then shows a version like
`1.1.0-edge.072fa31`, the commit that runs. Edge is not pinned: each rebuild can
bring in a newer commit. To go back to the pinned release, remove the
`KEPLER_PANEL_CHANNEL` line and rebuild. Either way, the previous image is left
dangling on disk; `docker image prune -f` clears it.

## Tests

```bash
npm ci && npx playwright install chromium
npm run test:config
docker compose build && npm run test:images
docker compose up --wait && npm run test:stack
```

The image tests expect the release channel; unset `KEPLER_PANEL_CHANNEL` (or remove it from `.env`)
before running them.

## License

Apache-2.0 ([LICENSE](LICENSE)). The images bundle Grafana, its plugins, DuckDB and TiTiler, each under its own license.
