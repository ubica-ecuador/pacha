# Pacha

*Pacha* is Quechua for the world and time as one.

Spatiotemporal visualization in Grafana, in one command: maps of moving things, sensors and
imagery, queried with DuckDB on the server or in the browser, from data read where it is
published.

**🌍 [Live gallery](https://pacha.ubica.dev)**: every dashboard in this repository, running.
No account needed.

> Not affiliated with Grafana Labs.

## The plugins

Pacha is the showcase and the test bench of three Grafana plugins made by
[Ubica](https://github.com/ubica-ecuador):

| Plugin | What it is | License |
|--------|------------|---------|
| [Kepler Geospatial Maps](https://github.com/ubica-ecuador/keplergl-grafana-panel) | [kepler.gl](https://kepler.gl) maps in a Grafana panel, fed by any data source: points, trips, origin–destination flows, H3, cloud-native imagery. [Documentation](https://docs.ubica.dev) | Apache-2.0, baked into the image |
| [Chaski](https://github.com/ubica-ecuador/chaski) | DuckDB in the browser (DuckDB-WASM) as a Grafana data source: load a dashboard's data once, then filter, group and join it in milliseconds. | Apache-2.0, baked into the image |
| [Kepler Geospatial Maps Plus](https://docs.ubica.dev/plus/) | The commercial edition of the Kepler panel, for operations maps: gauges, sparkline cards, live fleets, network links and 3D tiles, each drawn with its own time series. | Commercial, closed source; **not** in this repository or its images |

Around them the image bakes in the
[DuckDB data source](https://github.com/motherduckdb/grafana-duckdb-datasource) for queries on
the server, [Infinity](https://github.com/grafana/grafana-infinity-datasource), and
[Business Charts](https://grafana.com/grafana/plugins/volkovlabs-echarts-panel/), Table, Text and Variable. A
[TiTiler](https://developmentseed.org/titiler/) serves the imagery.

The free stack runs every dashboard in `dashboards/`. The dashboards in `plus/dashboards/` need
Kepler Plus; without it they are not loaded (see [Kepler Plus](#kepler-plus)).

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

The home page is a dashboard too, `dashboards/home.json`: every dashboard of the Gallery and
of Plus as a card, read from Grafana's search when the page opens, so a new dashboard shows
up on its own. The cards' screenshots and the page's assets live in `home/`, served by the
gateway at `/home/`; a card without a screenshot shows a plain background. To take or refresh
the screenshots (Chromium, in the Playwright container):

```bash
docker run --rm --network host --shm-size=2g -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD:/repo" -w /repo mcr.microsoft.com/playwright:v1.63.0-noble \
  node scripts/screenshots.mjs --base http://127.0.0.1:3000 [uid ...]
```

### Building dashboards with an AI agent

[AGENTS.md](AGENTS.md) holds the rules for agents working in this repository, and the
[build-dashboard skill](.claude/skills/build-dashboard/SKILL.md) the recipes and known
pitfalls of every engine and panel. The `mcp` service lets an agent read dashboards and run
panel queries.

## What runs

| Service   | What it does                                     | Reached at                        |
|-----------|--------------------------------------------------|-----------------------------------|
| `gateway` | nginx; the only published port. Caches the public feeds and adds their keys | `:3000`                           |
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

## Kepler Plus

Kepler Plus is not part of this repository or of the images it builds. `compose.plus.yaml` is
an overlay that mounts a copy of the Plus app you already have beside the baked plugins, and
turns on the `plus` Git Sync repository, which loads `plus/dashboards/` into a Plus folder:

```bash
PLUS_DIST=/path/to/ubica-keplerplus-app docker compose -f compose.yaml -f compose.plus.yaml up --wait
```

Without the overlay the Plus folder is not created and the free stack is complete on its own.
To get Plus, see [docs.ubica.dev/plus](https://docs.ubica.dev/plus/).

## Working on the Kepler panel

```bash
KEPLER_DIST=../keplergl-grafana-panel/dist docker compose -f compose.yaml -f compose.dev.yaml up --wait
```

To bake main of the Kepler repo into the image instead of its pinned release,
set `KEPLER_PANEL_CHANNEL=edge` in `.env` and run `docker compose up -d --build --wait`.
Every push to Kepler's main is published as its `edge` pre-release; building
again picks up the latest. Grafana's plugin page then shows a version like
`1.2.1-edge.072fa31`, the commit that runs. Edge is not pinned: each rebuild can
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
before running them. The Plus dashboards' tests skip when Plus is not mounted.

## License

Apache-2.0 ([LICENSE](LICENSE)), for the code and the dashboards in this repository. The images
bundle Grafana, its plugins, DuckDB and TiTiler, each under its own license. Kepler Geospatial
Maps Plus is not covered: it is a separate, commercial product.
