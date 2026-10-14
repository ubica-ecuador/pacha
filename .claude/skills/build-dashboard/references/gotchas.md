# Gotchas: silent failures and their fixes

Each one cost a debugging round. Check here first when something looks wrong. Add new ones
here, in the same shape: symptom, cause, fix.

## Maps

| Symptom | Cause | Fix |
|---|---|---|
| The map ignores its saved layers: default palette, coloured by the first numeric field | the saved layer points at `lat`/`lng`; the panel renamed the columns to `latitude`/`longitude`, so the layer found none and kepler fell back to automatic layers | name the SQL columns `latitude`/`longitude`, and `columns: {lat: 'latitude', lng: 'longitude'}` |
| The whole `mapConfig` is ignored | no top-level `"version": "v1"`, or `visualChannels` nested inside `config` | `{"version":"v1","config":{…}}`; `visualChannels` beside `config` |
| Empty map on a historical dataset | relative time range (`now-6h`) | save an absolute UTC range covering the data |
| Times off by hours | Kepler's clock is UTC | dashboard `timezone: "utc"`, ranges in UTC |
| Geometry column draws nothing, no error | raw DuckDB `GEOMETRY` sent as bytes | `ST_AsGeoJSON(g)::VARCHAR`, `ST_AsText`, or `ST_AsHEXWKB` |
| Polygons in the wrong place or NULL areas | `ST_Transform` without `always_xy := true` swaps axes | add `always_xy := true` |
| A vehicle table becomes trip lines | a column named `vehicle_id` (a trip-id role) | call it `vehicle`, or set the role to None |
| A track drawn high above the ground, vanishing when zoomed in | altitude mapped from an elevation above sea level | leave Altitude unmapped (it is opt-in for this reason) |
| Clicks publish nothing, `clickConfirm` opens no popup, on every layer of the map | the map has a **Trip** layer: kepler never sets `visState.clicked` then | select from a table row data link instead, with an "All …" row that clears |
| Every point of a filtered map gets an amber ring | the panel rings rows whose clicked column equals the variable; the map is already filtered to the selection | don't feed the selection back into the map's query |
| The map filters itself and cannot widen again | its own published variable (area, viewport, click) is in its own query | only other panels read it; the map filters with kepler filters |
| Flow layer stays yellow whatever `colorRange` says | flow layer ignores the palette | accept it, or use a Traffic layer; readable with `flowLinesRenderingMode: straight`, `flowLineThicknessScale` ~0.35 |
| Fleet trails join thousands of assets into scribbles | `fleetAssetField: auto` picked a low-cardinality string column | set `fleetAssetField` and `fleetTimeField` explicitly |
| A line across the whole world | track crosses the antimeridian | unwrap longitudes per asset in SQL, then shift so the newest point is in [-180, 180] |
| `fleetTimeRef: live` shows no vehicle at wall-clock now | the range reaches past now, so "now" is the end of the data | keep the range ending at `now` |
| Fleet cards with no chart | a card's chart needs ≥ 2 readings in its window | widen `fleetCardWindow`, or accept |
| A map that should follow the selection stays put | saved `mapState` | save without `mapState` and add a `center` mapping with `zoom` |
| Velocity layer draws nothing | lattice spacing wobbles > 5 %, or `u`/`v` NULL over land | regular lattice; drop land rows instead of NULLs |
| Zarr tiles look like patchwork | no `zarrRescale` | set `min,max` in the store's units |
| Raster colours like confetti | kepler's default ramp is for NDVI | set `rasterColormap`, or `rasterPainted` for classified rasters |
| CARTO base map watermarked | `dark-matter`/`positron`/`voyager` need a key since 2026-09 | use `openfreemap-*` |
| Plus panels show ChunkLoadError after a plugin deploy | Grafana registers plugin files at start | restart grafana; users hard-reload (chunks are cached 1 h) |

## SQL and engines

| Symptom | Cause | Fix |
|---|---|---|
| `''value''` parse error | `'$var'` on the DuckDB datasource, which quotes itself | `$var`; `${var:raw}` inside a string you build |
| Empty frame from a hand-written DuckDB query | `"format": "table"` | `"format": 1` |
| `strftime` binder error | no `TIMESTAMPTZ` overload | cast to `TIMESTAMP` first |
| `QUALIFY` error | bare `QUALIFY` without a window function | use a subquery |
| `SET VARIABLE x AS …` syntax error | wrong syntax | `SET VARIABLE x = (…)` |
| A dropdown value `11388.0` in URLs and cache keys | Chaski `values` hand integers back as doubles | `col::BIGINT::VARCHAR` for value and text |
| A sum renders as `[object Object]` or breaks a chart | `SUM(BIGINT)` → `HUGEINT`, serialised by DuckDB-WASM as an object | cast sums to `DOUBLE` |
| `h3_*` not found in Chaski | no H3 in the browser | compute on the server in the dataset's source query |
| Two variables break each other | a Chaski dataset and another variable share a name | unique names |
| Native barchart over Chaski shows a legend and no bars | unknown | Business Charts for bars over Chaski |
| `array_extract(VARCHAR[], DOUBLE)` binder error in Chaski on `list[n + 1]` | every numeric column of a server-fed dataset reaches the browser as DOUBLE | cast the index: `list[(n + 1)::BIGINT]` |
| "Cannot compare TIMESTAMP_MS and TIMESTAMP WITH TIME ZONE" in Chaski | a server-fed time column is TIMESTAMP_MS (naive UTC); `try_cast($var AS TIMESTAMPTZ)` is not | `try_cast($var AS TIMESTAMP)` (ISO strings with `Z` parse), and `now()::TIMESTAMP` (Chaski's TimeZone is UTC) |
| Stacked ECharts bars all start from zero | `stack` does not stack on a value or time x axis | a category axis per bin (a hidden time axis can carry the brush) |
| Infinity: "unable to merge fields due to different fields" on a filtered query | offset pagination asks for more pages than the filter leaves; the empty ones have no fields | don't filter the paginated query; filter in the map (kepler `variableMappings`) or fetch fewer pages |
| A stat of a time value shows "No data" | `reduceOptions.fields: ''` takes numeric fields only | `fields: "/.*/"` (as for a `dateTimeFromNow` "Latest data" stat) |
| A stat or table of a picked entity shows minuscule or truncated text | a long name in a narrow stat scales down; a table truncates | a Business Text panel (`marcusolsson-dynamictext-panel`, `renderMode: everyRow`) with a small HTML template (`fiware-valencia`) |
| A Business Chart writes a variable on click but its highlight stays on the old value | the panel redraws only when its query or code names that variable | name it: `${var}` in the code (redraws without re-querying) or `-- ${var:raw}` in the SQL |
| "Malformed JSON", about 1 query in 800, on a feed refreshed often | DuckDB's external file cache mixed two versions of a file | already off instance-wide; don't turn it on |
| "the remote file has changed" | a source that rebuilds the file per request | cache it in the gateway |
| "HTTP 0" from DuckDB | the server answered HEAD with 405, or ERDDAP refused a subset (400) | use another endpoint, or make every ERDDAP subset identical |
| `INSTALL` or local file read fails | by design: local filesystem off, no install | only the preloaded extensions; data from URLs |
| `http_get` times out | `http_client` gives up after about 10 s | batch; cache in the gateway |
| A gateway 404 rewritten by `error_page` comes back raw | nginx does not apply `proxy_intercept_errors` to a 404 served from cache | don't cache the status you rewrite |
| A geolife-style dashboard errors on one instance only | its `datasets/<name>/build.sh` has not run there | run it (GeoLife needs `GEOLIFE_MEMORY` ≥ 8 GB) |

## Grafana

| Symptom | Cause | Fix |
|---|---|---|
| Conditional rendering does nothing | it is on a `GridLayoutItem` | put it on a `RowsLayoutRow`, `TabsLayoutTab` or `AutoGridLayoutItem` |
| A panel empty in a screenshot or test | lazy rendering below the fold | scroll it into view first |
| A narrow table shows two columns and scrolls | Grafana 13's wide minimum width | `custom.minWidth` ~40 and per-column widths |
| The file changes after the first save in Grafana | hand-written formatting drifts from Grafana's | expected, once; commit Grafana's version |
| Admin login refused for minutes | failed logins from helpers without `.env` | always `--env-file=.env` |
| `localhost` refused from Node | Node resolves it to `::1` | `127.0.0.1` |
| Chromium crashes on a heavy map | default `/dev/shm` | `--shm-size=2g` |
