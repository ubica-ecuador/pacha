---
name: build-dashboard
description: Build or change a Pacha Grafana dashboard — DuckDB on the server, Chaski (DuckDB-WASM) in the browser, Kepler.gl free or Plus maps, Business Charts (ECharts). Use for any new dashboard, any edit to dashboards/ or plus/dashboards/, and any map, chart or SQL that goes into one.
---

# Building a Pacha dashboard

A dashboard here is a Grafana v2 resource JSON (`apiVersion: dashboard.grafana.app/v2`) in
`dashboards/gallery/` (free stack) or `plus/dashboards/` (needs Kepler Plus). Git Sync turns
the file into a dashboard (on a GitHub-synced instance a push is live: see `AGENTS.md`).

## The workflow

Do the steps in order. **Do not write the dashboard JSON before steps 1–3 are done.**

1. **Find the nearest existing dashboard** in the table below and read it. You copy its
   structure: the variables, the dataset pattern, the map options, the chart code. A dashboard
   written from memory gets the schema wrong; one copied from a working file does not.
   Changing an existing dashboard: `git fetch` and start from `origin/main`'s file.
2. **Pick the engine per dataset**, with [references/engines.md](references/engines.md):
   Chaski in the browser for interactive cross-filtering, DuckDB on the server for large or
   keyed sources and anything needing `spatial`, `h3` or `http_client`, Infinity for a plain
   JSON API. A Chaski dataset can be filled by a server query (`source.type: datasource`).
3. **Discover and validate the data in SQL** before shaping it, through the server DuckDB
   (recipe in [references/workflow.md](references/workflow.md)):
   - the schema from the source itself (`DESCRIBE`, `SUMMARIZE`), never from what the source
     "usually" has;
   - `count(*)`, the time span (`min`/`max`), the bbox (`min`/`max` of lat and lon), the
     share of null coordinates;
   - one magnitude check against a figure you know (a city's area, a fleet's size, a race's
     laps). Only then shape the columns for the panels.
4. **Shape the columns for the panel that draws them.** Kepler finds roles by exact column
   name (`latitude`, `longitude`, `trip_id`, `h3`, `geometry`, `lat0`…`lng1`, `raster_url`…),
   time by type. See [references/kepler.md](references/kepler.md).
5. **Write the JSON.** Grafana's own format (keys sorted, two-space indent, no trailing
   newline), uid = file name, a description that says what it shows, tags from the
   vocabulary in `dashboards/README.md`. Chart code: [references/business-charts.md](references/business-charts.md).
   Layouts, variables and Grafana 13 quirks: [references/grafana.md](references/grafana.md).
6. **Write the basic tests** `tests/stack/<uid>.test.mjs` (pattern in workflow.md).
7. **Preview, screenshot, look, fix.** Import a temporary copy, open it with Playwright, take
   a screenshot of every map and chart and look at it. Fix what the image shows, not what you
   expect it to show. No claim about what a map shows without this step.
8. **Hand the preview URL to the user.** On a GitHub-synced instance, push only after they
   approve, then delete the copy.

When something looks wrong, check [references/gotchas.md](references/gotchas.md) first: most
silent failures here (an empty chart, a map that ignores its layers, a click that does
nothing) are already in it.

## Which dashboard to copy

| You need | Copy from | Why |
|---|---|---|
| Points from a public GeoJSON feed, all in the browser, cross-filtered by map, brush and draw | `dashboards/gallery/earthquakes.json` | Chaski datasets, `areaVariable` + point-in-polygon without `spatial`, brush histogram, `timeSync: variables` |
| A server query over a large file into a browser dataset, then many small panels | `plus/dashboards/geolife-mobility.json` | `source.type: datasource`, a dataset built per instance (`datasets/geolife`), H3 on the server, flows, stops |
| Live vehicle positions (GTFS-RT, ADS-B, AIS) | `gtfs-rt-mbta-fleet`, `trimet-live-fleet`, `air-traffic-world` | Fleet layer, refresh, feeds through the gateway, recorder history |
| Replaying tracks with charts in sync | `f1-race-laps`, `drone-delivery-flights` | Fleet `fleetTimeRef: history`, cards, `SET VARIABLE` to build a URL from data, centre on selection |
| Trajectories, stops and trips | `denmark-ais-trajectories`, `animal-movement-tracking` | trip layers, selection from a table link (not a map click) |
| Sensors with series per site | `air-quality-amsterdam`, `melbourne-city-sensors` | Surface and Sparkline layers, `http_get` per station with whole-hour cache keys |
| Network links, flows between places | `germany-power-borders`, `datacenter-interconnection`, `international-migration` | Traffic, Gauge, Sparkline and Pipeline layers; arcs; Sankey and pyramid in ECharts |
| Origin–destination flows on a day | `spain-daily-mobility`, `trimet-live-fleet` (flow layer) | Traffic layer for OD links, municipality picker, bars against the national share |
| Lines and polygons with a value along them | `nyc-skyline-plus`, `wildfires-power-grid` | Pipeline layer, extruded GeoJSON buildings, proximity of points to lines in `spatial` |
| A grid or raster field (forecast, wind) | `gfs-wind-synoptic` | ERDDAP read on the server, velocity roles `u`/`v` |
| 3D tiles, sectors | `agi-hq-grid-cameras`, `caltrans-la-cameras` | tile3d, Coverage layer, dynamic text with live video |
| Computed geometry (orbits) | `starlink-constellation` | SQL that computes positions now, "overhead a point" |
| An HTTP JSON source without SQL | `gps-truck-track` | Infinity, hover sync between map and series |

The free panel's repository has many more source recipes (COG, STAC, PMTiles, Zarr, WMS,
OGC API, GeoParquet…): [references/spatial-sources.md](references/spatial-sources.md).

## Reference files

Read only what the task needs.

- [engines.md](references/engines.md): server DuckDB vs Chaski vs Infinity; how each is
  written in the JSON; variables and macros; what each engine cannot do.
- [kepler.md](references/kepler.md): the panel options, field roles, the saved `mapConfig`,
  cross-filtering, variable formats, free vs Plus.
- [kepler-plus-layers.md](references/kepler-plus-layers.md): the eight Plus layer types and
  their keys (gauge, prism, coverage, surface, sparkline, traffic, pipeline, fleet), Places and
  Alerts.
- [business-charts.md](references/business-charts.md): ECharts panels on Chaski frames; the
  `@constants` template; brush to variables; colours from the theme.
- [grafana.md](references/grafana.md): v2 JSON shapes, layouts, conditional rendering,
  hidden variables, tables, time ranges.
- [spatial-sources.md](references/spatial-sources.md): recipes by data family
  (vector files, OGC and Esri services, rasters and STAC, Zarr, H3, Iceberg, live feeds).
- [workflow.md](references/workflow.md): running SQL, the preview copy, Playwright
  screenshots, tests, committing.
- [gotchas.md](references/gotchas.md): every silent failure found so far, with its fix.

## Assets

- `assets/area-filter.sql`: point in the polygon a Kepler map publishes (`areaVariable`),
  in plain SQL, for Chaski (no `spatial`). `@cte` and `@predicate` parts.
- `assets/brush-histogram.js`: an ECharts histogram whose brush writes two variables. Change
  only its `@constants` block.

Both are tested by `tests/templates/`; a dashboard embeds a copy.
